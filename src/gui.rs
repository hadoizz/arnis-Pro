use crate::args::Args;
use crate::coordinate_system::cartesian::{XZBBox, XZPoint};
use crate::coordinate_system::geographic::{LLBBox, LLPoint};
use crate::coordinate_system::transformation::CoordTransformer;
use crate::data_processing::{self, GenerationOptions};
use crate::preview_mesh;
use crate::ground::{self, Ground};
use crate::map_transformation;
use crate::osm_parser;
use crate::progress::{self, emit_gui_progress_update};
use crate::retrieve_data;
use crate::telemetry::{self, send_log, LogLevel};
use crate::version_check;
use crate::world_editor::WorldFormat;
use colored::Colorize;
use fastnbt::Value;
use flate2::read::GzDecoder;
use fs2::FileExt;
use log::LevelFilter;
use rfd::FileDialog;
use std::io::Cursor;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::{env, fs, io::Write};
use tauri_plugin_log::{Builder as LogBuilder, Target, TargetKind};
use zip::ZipArchive;

/// Manages the session.lock file for a Minecraft world directory
struct SessionLock {
    file: fs::File,
    path: PathBuf,
}

impl SessionLock {
    /// Creates and locks a session.lock file in the specified world directory
    fn acquire(world_path: &Path) -> Result<Self, String> {
        let session_lock_path = world_path.join("session.lock");

        // Create or open the session.lock file
        let file = fs::File::create(&session_lock_path)
            .map_err(|e| format!("Failed to create session.lock file: {e}"))?;

        // Write the snowman character (U+2603) as specified by Minecraft format
        let snowman_bytes = "☃".as_bytes(); // This is UTF-8 encoded E2 98 83
        (&file)
            .write_all(snowman_bytes)
            .map_err(|e| format!("Failed to write to session.lock file: {e}"))?;

        // Acquire an exclusive lock on the file
        file.try_lock_exclusive()
            .map_err(|e| format!("Failed to acquire lock on session.lock file: {e}"))?;

        Ok(SessionLock {
            file,
            path: session_lock_path,
        })
    }
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        // Release the lock and remove the session.lock file
        let _ = self.file.unlock();
        let _ = fs::remove_file(&self.path);
    }
}

pub fn run_gui() {
    // Configure thread pool with 90% CPU cap to keep system responsive
    crate::floodfill_cache::configure_rayon_thread_pool(0.9);

    // Clean up old cached elevation tiles on startup
    crate::elevation_data::cleanup_old_cached_tiles();

    // Launch the UI
    println!("Launching UI...");

    // Install panic hook for crash reporting
    telemetry::install_panic_hook();

    // Workaround WebKit2GTK issue with NVIDIA drivers and graphics issues
    // Source: https://github.com/tauri-apps/tauri/issues/10702
    #[cfg(target_os = "linux")]
    unsafe {
        // Disable problematic GPU features that cause map loading issues
        env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

        // Force software rendering for better compatibility
        env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        env::set_var("GALLIUM_DRIVER", "softpipe");

        // Note: Removed sandbox disabling for security reasons
        // Note: Removed Qt WebEngine flags as they don't apply to Tauri
    }

    tauri::Builder::default()
        .plugin(
            LogBuilder::default()
                .level(LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::LogDir {
                        file_name: Some("arnis".into()),
                    }),
                    Target::new(TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            gui_create_world,
            gui_get_default_save_path,
            gui_set_save_path,
            gui_pick_save_directory,
            gui_start_generation,
            gui_get_version,
            gui_check_for_updates,
            gui_get_world_map_data,
            gui_get_preview_map_from_zip_base64,
            gui_build_import_preview_from_zip_base64,
            gui_get_world_preview_mesh_gzip_base64,
            gui_build_world_preview_mesh_gzip_base64,
            gui_show_in_folder
        ])
        .setup(|app| {
            let app_handle = app.handle();
            let main_window = tauri::Manager::get_webview_window(app_handle, "main")
                .expect("Failed to get main window");
            progress::set_main_window(main_window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error while starting the application UI (Tauri)");
}

/// Detects the default Minecraft Java Edition saves directory for the current OS.
/// Checks standard install paths including Flatpak on Linux.
/// Falls back to Desktop, then current directory.
fn detect_minecraft_saves_directory() -> PathBuf {
    // Try standard Minecraft saves directories per OS
    let mc_saves: Option<PathBuf> = if cfg!(target_os = "windows") {
        env::var("APPDATA")
            .ok()
            .map(|appdata| PathBuf::from(appdata).join(".minecraft").join("saves"))
    } else if cfg!(target_os = "macos") {
        dirs::home_dir().map(|home| {
            home.join("Library/Application Support/minecraft")
                .join("saves")
        })
    } else if cfg!(target_os = "linux") {
        dirs::home_dir().map(|home| {
            let flatpak_path = home.join(".var/app/com.mojang.Minecraft/.minecraft/saves");
            if flatpak_path.exists() {
                flatpak_path
            } else {
                home.join(".minecraft/saves")
            }
        })
    } else {
        None
    };

    if let Some(saves_dir) = mc_saves {
        if saves_dir.exists() {
            return saves_dir;
        }
    }

    // Fallback to Desktop
    if let Some(desktop) = dirs::desktop_dir() {
        if desktop.exists() {
            return desktop;
        }
    }

    // Last resort: current directory
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Extract `arnis_world_map.png` from a zip/.mcworld payload and return a data URL.
/// This is used by the GUI import-preview tab so users can preview without re-generating.
#[tauri::command]
fn gui_get_preview_map_from_zip_base64(zip_base64: String) -> Result<Option<String>, String> {
    // 60 MB safety cap (base64 inflates ~33%)
    if zip_base64.len() > 80_000_000 {
        return Err("Zip is too large for preview".to_string());
    }

    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, zip_base64.trim())
        .map_err(|e| format!("Invalid base64 zip: {e}"))?;
    if bytes.is_empty() {
        return Ok(None);
    }

    let cursor = Cursor::new(bytes);
    let mut zip = ZipArchive::new(cursor).map_err(|e| format!("Invalid zip: {e}"))?;

    // Look for `arnis_world_map.png` anywhere in the archive.
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| format!("Zip read: {e}"))?;
        if !f.is_file() {
            continue;
        }
        let name = f.name().replace('\\', "/");
        let lower = name.to_lowercase();
        if !lower.ends_with("arnis_world_map.png") {
            continue;
        }
        // Another safety cap: don’t read crazy huge “png”.
        if f.size() > 25_000_000 {
            return Err("Preview image in zip is too large".to_string());
        }
        let mut png = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut png)
            .map_err(|e| format!("Zip extract: {e}"))?;
        if png.is_empty() {
            return Ok(None);
        }
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png);
        return Ok(Some(format!("data:image/png;base64,{b64}")));
    }

    Ok(None)
}

#[derive(serde::Serialize)]
struct ImportPreviewResult {
    image_base64: String,
    min_mc_x: i32,
    max_mc_x: i32,
    min_mc_z: i32,
    max_mc_z: i32,
    world_path: String,
}

/// Build a real preview from a world zip/.mcworld (without normal generation flow).
/// - Extract archive to a temp folder
/// - Locate world root with `region/*.mca`
/// - Detect chunk bounds
/// - Render `arnis_world_map.png`
/// Returns image data URL + MC bounds for optional future use.
#[tauri::command]
fn gui_build_import_preview_from_zip_base64(zip_base64: String) -> Result<ImportPreviewResult, String> {
    if zip_base64.len() > 120_000_000 {
        return Err("Zip is too large for import preview".to_string());
    }

    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, zip_base64.trim())
        .map_err(|e| format!("Invalid base64 zip: {e}"))?;
    if bytes.is_empty() {
        return Err("Zip file is empty".to_string());
    }

    let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid zip: {e}"))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_root = env::temp_dir().join(format!("arnis-import-preview-{stamp}"));
    fs::create_dir_all(&out_root).map_err(|e| format!("Create temp dir failed: {e}"))?;

    extract_zip_archive(&mut zip, &out_root)?;

    // Prefer true Java region data (same path used by generated worlds) so import preview and
    // generation preview match in 2D/3D behavior.
    let maybe_world = find_best_world_root_and_bounds(&out_root);
    if maybe_world.is_none() {
        // Fallback only when no usable Java chunks exist.
        if let Some(png) = find_preview_png_in_tree(&out_root) {
            let image_base64 = format!(
                "data:image/png;base64,{}",
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png)
            );
            return Ok(ImportPreviewResult {
                image_base64,
                min_mc_x: 0,
                max_mc_x: 0,
                min_mc_z: 0,
                max_mc_z: 0,
                world_path: out_root.to_string_lossy().to_string(),
            });
        }
        return Err(
            "No Java region chunks found in zip. Bedrock archives are not supported for real preview yet."
                .to_string(),
        );
    }
    let (world_root, min_x, max_x, min_z, max_z) = maybe_world.unwrap();

    crate::map_renderer::render_world_map(&world_root, min_x, max_x, min_z, max_z)?;
    let mesh_world = world_root.clone();
    let mesh_min_x = min_x;
    let mesh_max_x = max_x;
    let mesh_min_z = min_z;
    let mesh_max_z = max_z;
    std::thread::spawn(move || {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match preview_mesh::generate_preview_mesh_gzip(
                &mesh_world,
                mesh_min_x,
                mesh_max_x,
                mesh_min_z,
                mesh_max_z,
            ) {
                Ok(gz) => {
                    let mesh_path = mesh_world.join("arnis_preview_mesh.bin.gz");
                    if let Err(e) = fs::write(&mesh_path, gz) {
                        eprintln!("Warning: import 3D preview mesh write failed: {e}");
                    }
                }
                Err(e) => eprintln!("Warning: import 3D preview mesh skipped: {e}"),
            }
        }));
    });
    let metadata = serde_json::json!({
        "minMcX": min_x,
        "maxMcX": max_x,
        "minMcZ": min_z,
        "maxMcZ": max_z,
        "minLat": 0.0,
        "maxLat": 0.0,
        "minLon": 0.0,
        "maxLon": 0.0
    });
    let metadata_path = world_root.join("metadata.json");
    fs::write(
        &metadata_path,
        serde_json::to_string_pretty(&metadata).map_err(|e| format!("Metadata encode failed: {e}"))?,
    )
    .map_err(|e| format!("Write metadata failed: {e}"))?;

    let png_path = world_root.join("arnis_world_map.png");
    let png = fs::read(&png_path).map_err(|e| format!("Read rendered preview failed: {e}"))?;
    let image_base64 = format!(
        "data:image/png;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png)
    );

    Ok(ImportPreviewResult {
        image_base64,
        min_mc_x: min_x,
        max_mc_x: max_x,
        min_mc_z: min_z,
        max_mc_z: max_z,
        world_path: world_root.to_string_lossy().to_string(),
    })
}

fn extract_zip_archive<R: Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    out_root: &Path,
) -> Result<(), String> {
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| format!("Zip read: {e}"))?;
        let raw_name = file.name().replace('\\', "/");
        if raw_name.contains("..") || raw_name.starts_with('/') || raw_name.contains(':') {
            continue;
        }

        let out_path = out_root.join(raw_name);
        if file.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("Create dir failed: {e}"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Create parent dir failed: {e}"))?;
        }

        let mut out = fs::File::create(&out_path).map_err(|e| format!("Write file failed: {e}"))?;
        std::io::copy(&mut file, &mut out).map_err(|e| format!("Extract file failed: {e}"))?;
    }
    Ok(())
}

fn find_preview_png_in_tree(root: &Path) -> Option<Vec<u8>> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let name = p.file_name()?.to_string_lossy().to_lowercase();
            if name == "arnis_world_map.png" {
                if let Ok(bytes) = fs::read(&p) {
                    if !bytes.is_empty() && is_useful_preview_png(&bytes) {
                        return Some(bytes);
                    }
                }
            }
        }
    }
    None
}

/// Reject almost-empty white previews so import can rebuild a real map from region chunks.
fn is_useful_preview_png(bytes: &[u8]) -> bool {
    let img = match image::load_from_memory(bytes) {
        Ok(v) => v.to_rgb8(),
        Err(_) => return false,
    };
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return false;
    }

    // Sample sparsely for speed on large maps.
    let step_x = (w / 200).max(1);
    let step_y = (h / 200).max(1);
    let mut total = 0usize;
    let mut non_white = 0usize;

    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let px = img.get_pixel(x, y).0;
            total += 1;
            // Not near-white background.
            if !(px[0] > 248 && px[1] > 248 && px[2] > 248) {
                non_white += 1;
            }
            x += step_x;
        }
        y += step_y;
    }

    // Require at least ~0.4% non-white pixels.
    (non_white as f64) / (total as f64) > 0.004
}

fn find_best_world_root_and_bounds(root: &Path) -> Option<(PathBuf, i32, i32, i32, i32)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if p.file_name().and_then(|n| n.to_str()) == Some("region") {
                    if let Some(parent) = p.parent() {
                        candidates.push(parent.to_path_buf());
                    }
                }
                stack.push(p);
            }
        }
    }

    let mut best: Option<(PathBuf, i32, i32, i32, i32, usize)> = None;
    for world_root in candidates {
        if let Ok((min_x, max_x, min_z, max_z, count)) = detect_world_bounds_from_regions(&world_root) {
            if count == 0 {
                continue;
            }
            match &best {
                Some((_p, _a, _b, _c, _d, best_count)) if *best_count >= count => {}
                _ => best = Some((world_root, min_x, max_x, min_z, max_z, count)),
            }
        }
    }

    best.map(|(p, min_x, max_x, min_z, max_z, _count)| (p, min_x, max_x, min_z, max_z))
}

fn detect_world_bounds_from_regions(world_root: &Path) -> Result<(i32, i32, i32, i32, usize), String> {
    let region_dir = world_root.join("region");
    if !region_dir.is_dir() {
        return Err("Missing region folder".to_string());
    }

    let mut min_chunk_x = i32::MAX;
    let mut max_chunk_x = i32::MIN;
    let mut min_chunk_z = i32::MAX;
    let mut max_chunk_z = i32::MIN;
    let mut found_any = false;
    let mut chunk_count: usize = 0;

    let entries = fs::read_dir(&region_dir).map_err(|e| format!("Read region dir failed: {e}"))?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|x| x.to_str()) != Some("mca") {
            continue;
        }
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        let parts: Vec<&str> = name.split('.').collect();
        if parts.len() != 4 || parts[0] != "r" || parts[3] != "mca" {
            continue;
        }
        let rx = match parts[1].parse::<i32>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let rz = match parts[2].parse::<i32>() {
            Ok(v) => v,
            Err(_) => continue,
        };

        let f = match fs::File::open(&p) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mut region = match fastanvil::Region::from_stream(f) {
            Ok(v) => v,
            Err(_) => continue,
        };

        for lx in 0..32usize {
            for lz in 0..32usize {
                match region.read_chunk(lx, lz) {
                    Ok(Some(_)) => {
                        let cx = rx * 32 + lx as i32;
                        let cz = rz * 32 + lz as i32;
                        min_chunk_x = min_chunk_x.min(cx);
                        max_chunk_x = max_chunk_x.max(cx);
                        min_chunk_z = min_chunk_z.min(cz);
                        max_chunk_z = max_chunk_z.max(cz);
                        found_any = true;
                        chunk_count += 1;
                    }
                    _ => {}
                }
            }
        }
    }

    if !found_any {
        return Err("No chunks found in region files".to_string());
    }

    Ok((
        min_chunk_x * 16,
        max_chunk_x * 16 + 15,
        min_chunk_z * 16,
        max_chunk_z * 16 + 15,
        chunk_count,
    ))
}

/// Returns the default save path (auto-detected on first run).
/// The frontend stores/retrieves this via localStorage and passes it here for validation.
#[tauri::command]
fn gui_get_default_save_path() -> String {
    detect_minecraft_saves_directory().display().to_string()
}

/// Validates and returns a user-provided save path.
/// Returns the path string if valid, or an error message.
#[tauri::command]
fn gui_set_save_path(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("Path does not exist.".to_string());
    }
    if !p.is_dir() {
        return Err("Path is not a directory.".to_string());
    }
    Ok(path)
}

/// Opens a native folder-picker dialog and returns the chosen path.
#[tauri::command]
fn gui_pick_save_directory(start_path: String) -> Result<String, String> {
    let start = PathBuf::from(&start_path);
    let mut dialog = FileDialog::new();
    if start.is_dir() {
        dialog = dialog.set_directory(&start);
    }
    match dialog.pick_folder() {
        Some(folder) => Ok(folder.display().to_string()),
        None => Ok(start_path),
    }
}

/// Creates a new Java Edition world in the given base save directory.
/// Called when the user clicks "Create World".
#[tauri::command]
fn gui_create_world(save_path: String) -> Result<String, i32> {
    let trimmed = save_path.trim();
    if trimmed.is_empty() {
        return Err(3);
    }
    let base = PathBuf::from(trimmed);
    if !base.is_dir() {
        return Err(3); // Error code 3: Failed to create new world
    }
    create_new_world(&base).map_err(|_| 3)
}

fn create_new_world(base_path: &Path) -> Result<String, String> {
    crate::world_utils::create_new_world(base_path)
}

/// Adds localized area name to the world name in level.dat
fn add_localized_world_name(world_path: PathBuf, bbox: &LLBBox) -> PathBuf {
    // Only proceed if the path exists
    if !world_path.exists() {
        return world_path;
    }

    // Check the level.dat file first to get the current name
    let level_path = world_path.join("level.dat");

    if !level_path.exists() {
        return world_path;
    }

    // Try to read the current world name from level.dat
    let Ok(level_data) = std::fs::read(&level_path) else {
        return world_path;
    };

    let mut decoder = GzDecoder::new(level_data.as_slice());
    let mut decompressed_data = Vec::new();
    if decoder.read_to_end(&mut decompressed_data).is_err() {
        return world_path;
    }

    let Ok(Value::Compound(ref root)) = fastnbt::from_bytes::<Value>(&decompressed_data) else {
        return world_path;
    };

    let Some(Value::Compound(ref data)) = root.get("Data") else {
        return world_path;
    };

    let Some(Value::String(current_name)) = data.get("LevelName") else {
        return world_path;
    };

    // Only modify if it's an Arnis world and doesn't already have an area name
    if !current_name.starts_with("Arnis World ") || current_name.contains(": ") {
        return world_path;
    }

    // Calculate center coordinates of bbox
    let center_lat = (bbox.min().lat() + bbox.max().lat()) / 2.0;
    let center_lon = (bbox.min().lng() + bbox.max().lng()) / 2.0;

    // Try to fetch the area name
    let area_name = match retrieve_data::fetch_area_name(center_lat, center_lon) {
        Ok(Some(name)) => name,
        _ => return world_path, // Keep original name if no area name found
    };

    // Create new name with localized area name, ensuring total length doesn't exceed 30 characters
    let base_name = current_name.clone();
    let max_area_name_len = 30 - base_name.len() - 2; // 2 chars for ": "

    let truncated_area_name =
        if area_name.chars().count() > max_area_name_len && max_area_name_len > 0 {
            // Truncate the area name to fit within the 30 character limit
            area_name
                .chars()
                .take(max_area_name_len)
                .collect::<String>()
        } else if max_area_name_len == 0 {
            // If base name is already too long, don't add area name
            return world_path;
        } else {
            area_name
        };

    let new_name = format!("{base_name}: {truncated_area_name}");

    // Update the level.dat file with the new name
    if let Ok(level_data) = std::fs::read(&level_path) {
        let mut decoder = GzDecoder::new(level_data.as_slice());
        let mut decompressed_data = Vec::new();
        if decoder.read_to_end(&mut decompressed_data).is_ok() {
            if let Ok(mut nbt_data) = fastnbt::from_bytes::<Value>(&decompressed_data) {
                // Update the level name in NBT data
                if let Value::Compound(ref mut root) = nbt_data {
                    if let Some(Value::Compound(ref mut data)) = root.get_mut("Data") {
                        data.insert("LevelName".to_string(), Value::String(new_name));

                        // Save the updated NBT data
                        if let Ok(serialized_data) = fastnbt::to_bytes(&nbt_data) {
                            let mut encoder = flate2::write::GzEncoder::new(
                                Vec::new(),
                                flate2::Compression::default(),
                            );
                            if encoder.write_all(&serialized_data).is_ok() {
                                if let Ok(compressed_data) = encoder.finish() {
                                    if let Err(e) = std::fs::write(&level_path, compressed_data) {
                                        eprintln!("Failed to update level.dat with area name: {e}");
                                        #[cfg(feature = "gui")]
                                        send_log(
                                            LogLevel::Warning,
                                            "Failed to update level.dat with area name",
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Return the original path since we didn't change the directory name
    world_path
}

/// Calculates the default spawn point at X=1, Z=1 relative to the world origin.
/// This is used when no spawn point is explicitly selected by the user.
fn calculate_default_spawn(xzbbox: &XZBBox) -> (i32, i32) {
    (xzbbox.min_x() + 1, xzbbox.min_z() + 1)
}

/// Sets the player spawn point in level.dat using Minecraft XZ coordinates.
/// The Y coordinate is set to a temporary value (150) and will be updated
/// after terrain generation by `update_player_spawn_y_after_generation`.
fn set_player_spawn_in_level_dat(
    world_path: &str,
    spawn_x: i32,
    spawn_z: i32,
) -> Result<(), String> {
    // Default y spawn position since terrain elevation cannot be determined yet
    let y = 150.0;

    // Read and update the level.dat file
    let level_path = PathBuf::from(world_path).join("level.dat");
    if !level_path.exists() {
        return Err(format!("Level.dat not found at {level_path:?}"));
    }

    // Read the level.dat file
    let level_data = match std::fs::read(&level_path) {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to read level.dat: {e}")),
    };

    // Decompress and parse the NBT data
    let mut decoder = GzDecoder::new(level_data.as_slice());
    let mut decompressed_data = Vec::new();
    if let Err(e) = decoder.read_to_end(&mut decompressed_data) {
        return Err(format!("Failed to decompress level.dat: {e}"));
    }

    let mut nbt_data = match fastnbt::from_bytes::<Value>(&decompressed_data) {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to parse level.dat NBT data: {e}")),
    };

    // Update player position and world spawn point
    if let Value::Compound(ref mut root) = nbt_data {
        if let Some(Value::Compound(ref mut data)) = root.get_mut("Data") {
            // Set world spawn point
            data.insert("SpawnX".to_string(), Value::Int(spawn_x));
            data.insert("SpawnY".to_string(), Value::Int(y as i32));
            data.insert("SpawnZ".to_string(), Value::Int(spawn_z));

            // Update player position if Player compound exists
            if let Some(Value::Compound(ref mut player)) = data.get_mut("Player") {
                if let Some(Value::List(ref mut pos)) = player.get_mut("Pos") {
                    // Safely update position values with bounds checking
                    if pos.len() >= 3 {
                        if let Some(Value::Double(ref mut pos_x)) = pos.get_mut(0) {
                            *pos_x = spawn_x as f64;
                        }
                        if let Some(Value::Double(ref mut pos_y)) = pos.get_mut(1) {
                            *pos_y = y;
                        }
                        if let Some(Value::Double(ref mut pos_z)) = pos.get_mut(2) {
                            *pos_z = spawn_z as f64;
                        }
                    }
                }
            }
        }
    }

    // Serialize and save the updated level.dat
    let serialized_data = match fastnbt::to_bytes(&nbt_data) {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to serialize updated level.dat: {e}")),
    };

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    if let Err(e) = encoder.write_all(&serialized_data) {
        return Err(format!("Failed to compress updated level.dat: {e}"));
    }

    let compressed_data = match encoder.finish() {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to finalize compression for level.dat: {e}")),
    };

    // Write the updated level.dat file
    if let Err(e) = std::fs::write(level_path, compressed_data) {
        return Err(format!("Failed to write updated level.dat: {e}"));
    }

    Ok(())
}

// Function to update player spawn Y coordinate based on terrain height after generation
// This updates the spawn Y coordinate to be at terrain height + 3 blocks
pub fn update_player_spawn_y_after_generation(
    world_path: &Path,
    bbox_text: String,
    scale: f64,
    ground: &Ground,
) -> Result<(), String> {
    use crate::coordinate_system::transformation::CoordTransformer;

    // Read the current level.dat file to get existing spawn coordinates
    let level_path = PathBuf::from(world_path).join("level.dat");
    if !level_path.exists() {
        return Err(format!("Level.dat not found at {level_path:?}"));
    }

    // Read the level.dat file
    let level_data = match std::fs::read(&level_path) {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to read level.dat: {e}")),
    };

    // Decompress and parse the NBT data
    let mut decoder = GzDecoder::new(level_data.as_slice());
    let mut decompressed_data = Vec::new();
    if let Err(e) = decoder.read_to_end(&mut decompressed_data) {
        return Err(format!("Failed to decompress level.dat: {e}"));
    }

    let mut nbt_data = match fastnbt::from_bytes::<Value>(&decompressed_data) {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to parse level.dat NBT data: {e}")),
    };

    // Get existing spawn coordinates and calculate new Y based on terrain
    let (existing_spawn_x, existing_spawn_z) = if let Value::Compound(ref root) = nbt_data {
        if let Some(Value::Compound(ref data)) = root.get("Data") {
            let spawn_x = data.get("SpawnX").and_then(|v| {
                if let Value::Int(x) = v {
                    Some(*x)
                } else {
                    None
                }
            });
            let spawn_z = data.get("SpawnZ").and_then(|v| {
                if let Value::Int(z) = v {
                    Some(*z)
                } else {
                    None
                }
            });

            match (spawn_x, spawn_z) {
                (Some(x), Some(z)) => (x, z),
                _ => {
                    return Err("Spawn coordinates not found in level.dat".to_string());
                }
            }
        } else {
            return Err("Invalid level.dat structure: no Data compound".to_string());
        }
    } else {
        return Err("Invalid level.dat structure: root is not a compound".to_string());
    };

    // Calculate terrain-based Y coordinate
    let spawn_y = if ground.elevation_enabled {
        // Parse coordinates for terrain lookup
        let llbbox = LLBBox::from_str(&bbox_text)
            .map_err(|e| format!("Failed to parse bounding box for spawn point:\n{e}"))?;
        let (_, xzbbox) = CoordTransformer::llbbox_to_xzbbox(&llbbox, scale)
            .map_err(|e| format!("Failed to build transformation:\n{e}"))?;

        // Calculate relative coordinates for ground system
        let relative_x = existing_spawn_x - xzbbox.min_x();
        let relative_z = existing_spawn_z - xzbbox.min_z();
        let terrain_point = XZPoint::new(relative_x, relative_z);

        ground.level(terrain_point) + 3 // Add 3 blocks above terrain for safety
    } else {
        -61 // Default Y if no terrain
    };

    // Update player position and world spawn point
    if let Value::Compound(ref mut root) = nbt_data {
        if let Some(Value::Compound(ref mut data)) = root.get_mut("Data") {
            // Only update the Y coordinate, keep existing X and Z
            data.insert("SpawnY".to_string(), Value::Int(spawn_y));

            // Update player position - only Y coordinate
            if let Some(Value::Compound(ref mut player)) = data.get_mut("Player") {
                if let Some(Value::List(ref mut pos)) = player.get_mut("Pos") {
                    // Safely update Y position with bounds checking
                    if let Some(Value::Double(ref mut pos_y)) = pos.get_mut(1) {
                        *pos_y = spawn_y as f64;
                    }
                }
            }
        }
    }

    // Serialize and save the updated level.dat
    let serialized_data = match fastnbt::to_bytes(&nbt_data) {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to serialize updated level.dat: {e}")),
    };

    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    if let Err(e) = encoder.write_all(&serialized_data) {
        return Err(format!("Failed to compress updated level.dat: {e}"));
    }

    let compressed_data = match encoder.finish() {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to finalize compression for level.dat: {e}")),
    };

    // Write the updated level.dat file
    if let Err(e) = std::fs::write(level_path, compressed_data) {
        return Err(format!("Failed to write updated level.dat: {e}"));
    }

    Ok(())
}

#[tauri::command]
fn gui_get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn gui_check_for_updates() -> Result<bool, String> {
    match version_check::check_for_updates() {
        Ok(is_newer) => Ok(is_newer),
        Err(e) => Err(format!("Error checking for updates: {e}")),
    }
}

/// Returns the world map image data as base64 and geo bounds for overlay display.
/// Returns None if the map image or metadata doesn't exist.
#[tauri::command]
fn gui_get_world_map_data(world_path: String) -> Result<Option<WorldMapData>, String> {
    let world_dir = PathBuf::from(&world_path);
    let map_path = world_dir.join("arnis_world_map.png");
    let metadata_path = world_dir.join("metadata.json");

    // Check if both files exist
    if !map_path.exists() || !metadata_path.exists() {
        return Ok(None);
    }

    // Read and encode the map image as base64
    let image_data = fs::read(&map_path).map_err(|e| format!("Failed to read map image: {e}"))?;
    let base64_image =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &image_data);

    // Read metadata
    let metadata_content =
        fs::read_to_string(&metadata_path).map_err(|e| format!("Failed to read metadata: {e}"))?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata_content)
        .map_err(|e| format!("Failed to parse metadata: {e}"))?;

    // Extract geo bounds (metadata uses camelCase from serde)
    let min_lat = metadata["minGeoLat"]
        .as_f64()
        .ok_or("Missing minGeoLat in metadata")?;
    let max_lat = metadata["maxGeoLat"]
        .as_f64()
        .ok_or("Missing maxGeoLat in metadata")?;
    let min_lon = metadata["minGeoLon"]
        .as_f64()
        .ok_or("Missing minGeoLon in metadata")?;
    let max_lon = metadata["maxGeoLon"]
        .as_f64()
        .ok_or("Missing maxGeoLon in metadata")?;

    // Extract Minecraft coordinate bounds
    let min_mc_x = metadata["minMcX"].as_i64().unwrap_or(0) as i32;
    let max_mc_x = metadata["maxMcX"].as_i64().unwrap_or(0) as i32;
    let min_mc_z = metadata["minMcZ"].as_i64().unwrap_or(0) as i32;
    let max_mc_z = metadata["maxMcZ"].as_i64().unwrap_or(0) as i32;

    Ok(Some(WorldMapData {
        image_base64: format!("data:image/png;base64,{}", base64_image),
        min_lat,
        max_lat,
        min_lon,
        max_lon,
        min_mc_x,
        max_mc_x,
        min_mc_z,
        max_mc_z,
    }))
}

/// Fast read of cached 3D mesh (`arnis_preview_mesh.bin.gz`). Does **not** build — avoids blocking
/// the world preview modal; use `gui_build_world_preview_mesh_gzip_base64` when the user opens 3D.
#[tauri::command]
fn gui_get_world_preview_mesh_gzip_base64(world_path: String) -> Result<Option<String>, String> {
    let mesh_path = PathBuf::from(world_path.trim()).join("arnis_preview_mesh.bin.gz");
    if !mesh_path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&mesh_path).map_err(|e| format!("Failed to read 3D preview: {e}"))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &bytes,
    )))
}

/// Builds the 3D preview mesh from `metadata.json` + region files (can take a while). Only call from
/// the 3D tab, not when opening the post-generation preview dialog.
#[tauri::command]
async fn gui_build_world_preview_mesh_gzip_base64(world_path: String) -> Result<Option<String>, String> {
    let world = PathBuf::from(world_path.trim());
    let mesh_path = world.join("arnis_preview_mesh.bin.gz");

    let meta_path = world.join("metadata.json");
    if !meta_path.is_file() {
        return Ok(None);
    }

    let meta_str = fs::read_to_string(&meta_path)
        .map_err(|e| format!("Failed to read metadata for 3D preview: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&meta_str).map_err(|e| format!("Invalid metadata.json: {e}"))?;

    let min_x = v["minMcX"]
        .as_i64()
        .ok_or("metadata missing minMcX")? as i32;
    let max_x = v["maxMcX"]
        .as_i64()
        .ok_or("metadata missing maxMcX")? as i32;
    let min_z = v["minMcZ"]
        .as_i64()
        .ok_or("metadata missing minMcZ")? as i32;
    let max_z = v["maxMcZ"]
        .as_i64()
        .ok_or("metadata missing maxMcZ")? as i32;

    let world_clone = world.clone();
    let mesh_path_clone = mesh_path.clone();

    let mesh_bytes = tokio::task::spawn_blocking(move || {
        let mesh = preview_mesh::generate_preview_mesh_gzip(&world_clone, min_x, max_x, min_z, max_z)?;
        fs::write(&mesh_path_clone, &mesh)
            .map_err(|e| format!("Failed to save 3D preview cache: {e}"))?;
        Ok::<Vec<u8>, String>(mesh)
    })
    .await
    .map_err(|e| format!("3D preview task: {e}"))??;

    if mesh_bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &mesh_bytes,
    )))
}

/// Data structure for world map overlay
#[derive(serde::Serialize)]
struct WorldMapData {
    image_base64: String,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    // Minecraft coordinate bounds for coordinate copying
    min_mc_x: i32,
    max_mc_x: i32,
    min_mc_z: i32,
    max_mc_z: i32,
}

/// Opens the file with default application (Windows) or shows in file explorer (macOS/Linux)
#[tauri::command]
fn gui_show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows, try to open with default application (Minecraft Bedrock)
        // If that fails, show in Explorer
        if std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .is_err()
        {
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| format!("Failed to open explorer: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS, just reveal in Finder
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, just show in file manager
        let path_parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());

        // Try nautilus with select first, then fall back to xdg-open on parent
        if std::process::Command::new("nautilus")
            .args(["--select", &path])
            .spawn()
            .is_err()
        {
            let _ = std::process::Command::new("xdg-open")
                .arg(&path_parent)
                .spawn();
        }
    }

    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
#[allow(unused_variables)]
fn gui_start_generation(
    bbox_text: String,
    selected_world: String,
    world_scale: f64,
    ground_level: i32,
    terrain_enabled: bool,
    skip_osm_objects: bool,
    interior_enabled: bool,
    roof_enabled: bool,
    fillground_enabled: bool,
    city_boundaries_enabled: bool,
    is_new_world: bool,
    spawn_point: Option<(f64, f64)>,
    telemetry_consent: bool,
    world_format: String,
) -> Result<(), String> {
    use progress::emit_gui_error;
    use LLBBox;

    // Store telemetry consent for crash reporting
    telemetry::set_telemetry_consent(telemetry_consent);

    // Send generation click telemetry
    telemetry::send_generation_click();

    // For new Java worlds, set the spawn point in level.dat
    // Only update player position for Java worlds - Bedrock worlds don't have a pre-existing
    // level.dat to modify (the spawn point will be set when the .mcworld is created)
    if is_new_world && world_format != "bedrock" {
        let llbbox = match LLBBox::from_str(&bbox_text) {
            Ok(bbox) => bbox,
            Err(e) => {
                let error_msg = format!("Failed to parse bounding box: {e}");
                eprintln!("{error_msg}");
                emit_gui_error(&error_msg);
                return Err(error_msg);
            }
        };

        let (transformer, xzbbox) = match CoordTransformer::llbbox_to_xzbbox(&llbbox, world_scale) {
            Ok(result) => result,
            Err(e) => {
                let error_msg = format!("Failed to create coordinate transformer: {e}");
                eprintln!("{error_msg}");
                emit_gui_error(&error_msg);
                return Err(error_msg);
            }
        };

        let (spawn_x, spawn_z) = if let Some(coords) = spawn_point {
            // User selected a spawn point - verify it's within bounds and convert to XZ
            let llpoint = LLPoint::new(coords.0, coords.1)
                .map_err(|e| format!("Failed to parse spawn point: {e}"))?;

            if llbbox.contains(&llpoint) {
                let xzpoint = transformer.transform_point(llpoint);
                (xzpoint.x, xzpoint.z)
            } else {
                // Spawn point outside bounds, use default
                calculate_default_spawn(&xzbbox)
            }
        } else {
            // No user-selected spawn point - use default at X=1, Z=1 relative to world origin
            calculate_default_spawn(&xzbbox)
        };

        set_player_spawn_in_level_dat(&selected_world, spawn_x, spawn_z)
            .map_err(|e| format!("Failed to set spawn point: {e}"))?;
    }

    tauri::async_runtime::spawn(async move {
        if let Err(e) = tokio::task::spawn_blocking(move || {
            let world_path = PathBuf::from(&selected_world);

            // Determine world format from UI selection first (needed for session lock decision)
            let world_format = if world_format == "bedrock" {
                WorldFormat::BedrockMcWorld
            } else {
                WorldFormat::JavaAnvil
            };

            // Check available disk space before starting generation (minimum 3GB required)
            const MIN_DISK_SPACE_BYTES: u64 = 3 * 1024 * 1024 * 1024; // 3 GB
            let check_path = if world_format == WorldFormat::JavaAnvil {
                world_path.clone()
            } else {
                // Bedrock output goes to Desktop (or home / "." fallback) — must match
                // `build_bedrock_output`, not `current_dir()` (often install / shortcut folder).
                crate::world_utils::get_bedrock_output_directory()
            };
            match fs2::available_space(&check_path) {
                Ok(available) if available < MIN_DISK_SPACE_BYTES => {
                    let error_msg = "Not enough disk space available.".to_string();
                    eprintln!("{error_msg}");
                    emit_gui_error(&error_msg);
                    return Err(error_msg);
                }
                Err(e) => {
                    // Log warning but don't block generation if we can't check space
                    eprintln!("Warning: Could not check disk space: {e}");
                }
                _ => {} // Sufficient space available
            }

            // Acquire session lock for Java worlds only
            // Session lock prevents Minecraft from having the world open during generation
            // Bedrock worlds are generated as .mcworld files and don't need this lock
            let _session_lock: Option<SessionLock> = if world_format == WorldFormat::JavaAnvil {
                match SessionLock::acquire(&world_path) {
                    Ok(lock) => Some(lock),
                    Err(e) => {
                        let error_msg = format!("Failed to acquire session lock: {e}");
                        eprintln!("{error_msg}");
                        emit_gui_error(&error_msg);
                        return Err(error_msg);
                    }
                }
            } else {
                None
            };

            // Parse the bounding box from the text with proper error handling
            let bbox = match LLBBox::from_str(&bbox_text) {
                Ok(bbox) => bbox,
                Err(e) => {
                    let error_msg = format!("Failed to parse bounding box: {e}");
                    eprintln!("{error_msg}");
                    emit_gui_error(&error_msg);
                    return Err(error_msg);
                }
            };

            // Determine output path and level name based on format
            let (generation_path, level_name) = match world_format {
                WorldFormat::JavaAnvil => {
                    // Java: use the selected world path, add localized name if new
                    let updated_path = if is_new_world {
                        add_localized_world_name(world_path.clone(), &bbox)
                    } else {
                        world_path.clone()
                    };
                    (updated_path, None)
                }
                WorldFormat::BedrockMcWorld => {
                    // Bedrock: generate .mcworld on Desktop with location-based name
                    let output_dir = crate::world_utils::get_bedrock_output_directory();
                    let (output_path, lvl_name) =
                        crate::world_utils::build_bedrock_output(&bbox, output_dir);
                    (output_path, Some(lvl_name))
                }
            };

            // Calculate MC spawn coordinates from lat/lng if spawn point was provided
            // Otherwise, default to X=1, Z=1 (relative to xzbbox min coordinates)
            let mc_spawn_point: Option<(i32, i32)> = if let Some((lat, lng)) = spawn_point {
                if let Ok(llpoint) = LLPoint::new(lat, lng) {
                    if let Ok((transformer, _)) =
                        CoordTransformer::llbbox_to_xzbbox(&bbox, world_scale)
                    {
                        let xzpoint = transformer.transform_point(llpoint);
                        Some((xzpoint.x, xzpoint.z))
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                // Default spawn point: X=1, Z=1 relative to world origin
                if let Ok((_, xzbbox)) = CoordTransformer::llbbox_to_xzbbox(&bbox, world_scale) {
                    Some(calculate_default_spawn(&xzbbox))
                } else {
                    None
                }
            };

            // Create generation options
            let generation_options = GenerationOptions {
                path: generation_path.clone(),
                format: world_format,
                level_name,
                spawn_point: mc_spawn_point,
            };

            // Create an Args instance with the chosen bounding box
            // Note: path is used for Java-specific features like spawn point update
            let args: Args = Args {
                bbox,
                file: None,
                save_json_file: None,
                path: Some(if world_format == WorldFormat::JavaAnvil {
                    generation_path
                } else {
                    world_path
                }),
                bedrock: world_format == WorldFormat::BedrockMcWorld,
                downloader: "requests".to_string(),
                scale: world_scale,
                ground_level,
                terrain: terrain_enabled,
                interior: interior_enabled,
                roof: roof_enabled,
                fillground: fillground_enabled,
                city_boundaries: city_boundaries_enabled,
                debug: false,
                timeout: Some(std::time::Duration::from_secs(40)),
                spawn_lat: None,
                spawn_lng: None,
            };

            // If skip_osm_objects is true (terrain-only mode), skip fetching and processing OSM data
            if skip_osm_objects {
                // Generate ground data (terrain) for terrain-only mode
                let ground = ground::generate_ground_data(&args);

                // Create empty parsed_elements and xzbbox for terrain-only mode
                let parsed_elements = Vec::new();
                let (_coord_transformer, xzbbox) =
                    CoordTransformer::llbbox_to_xzbbox(&args.bbox, args.scale)
                        .map_err(|e| format!("Failed to create coordinate transformer: {}", e))?;

                let _ = data_processing::generate_world_with_options(
                    parsed_elements,
                    xzbbox.clone(),
                    args.bbox,
                    ground,
                    &args,
                    generation_options.clone(),
                );
                // Explicitly release session lock before showing Done message
                // so Minecraft can open the world immediately
                drop(_session_lock);
                emit_gui_progress_update(100.0, "Done! World generation completed.");
                println!("{}", "Done! World generation completed.".green().bold());

                // Start map preview generation silently in background (Java only)
                if world_format == WorldFormat::JavaAnvil {
                    let preview_info = data_processing::MapPreviewInfo::new(
                        generation_options.path.clone(),
                        &xzbbox,
                    );
                    data_processing::start_map_preview_generation(preview_info);
                }

                return Ok(());
            }

            // Run data fetch and world generation (standard mode: objects + terrain, or objects only)
            match retrieve_data::fetch_data_from_overpass(args.bbox, args.debug, "requests", None) {
                Ok(raw_data) => {
                    let (mut parsed_elements, mut xzbbox) =
                        osm_parser::parse_osm_data(raw_data, args.bbox, args.scale, args.debug);
                    parsed_elements.sort_by(|el1, el2| {
                        let (el1_priority, el2_priority) =
                            (osm_parser::get_priority(el1), osm_parser::get_priority(el2));
                        match (
                            el1.tags().contains_key("landuse"),
                            el2.tags().contains_key("landuse"),
                        ) {
                            (true, false) => std::cmp::Ordering::Greater,
                            (false, true) => std::cmp::Ordering::Less,
                            _ => el1_priority.cmp(&el2_priority),
                        }
                    });

                    let mut ground = ground::generate_ground_data(&args);

                    // Transform map (parsed_elements). Operations are defined in a json file
                    map_transformation::transform_map(
                        &mut parsed_elements,
                        &mut xzbbox,
                        &mut ground,
                    );

                    let _ = data_processing::generate_world_with_options(
                        parsed_elements,
                        xzbbox.clone(),
                        args.bbox,
                        ground,
                        &args,
                        generation_options.clone(),
                    );
                    // Explicitly release session lock before showing Done message
                    // so Minecraft can open the world immediately
                    drop(_session_lock);
                    emit_gui_progress_update(100.0, "Done! World generation completed.");
                    println!("{}", "Done! World generation completed.".green().bold());

                    // Start map preview generation silently in background (Java only)
                    if world_format == WorldFormat::JavaAnvil {
                        let preview_info = data_processing::MapPreviewInfo::new(
                            generation_options.path.clone(),
                            &xzbbox,
                        );
                        data_processing::start_map_preview_generation(preview_info);
                    }

                    Ok(())
                }
                Err(e) => {
                    emit_gui_error(&e.to_string());
                    // Session lock will be automatically released when _session_lock goes out of scope
                    Err(e.to_string())
                }
            }
        })
        .await
        {
            let error_msg = format!("Error in blocking task: {e}");
            eprintln!("{error_msg}");
            emit_gui_error(&error_msg);
            // Session lock will be automatically released when the task fails
        }
    });

    Ok(())
}
