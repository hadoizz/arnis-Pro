//! Face-culled voxel mesh for a 3D world preview in the GUI (Three.js).
//! Java Anvil worlds only. Uses the same block colors as `map_renderer`.

use crate::map_renderer::{
    block_name_at_local_in_section, get_sections_from_chunk, is_transparent_block, rgb_for_block_name,
};
use fastanvil::Region;
use fastnbt::{from_bytes, Value};
use flate2::write::GzEncoder;
use flate2::Compression;
use image::Rgb;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::Path;

/// Max keys while scanning (sparse grid before we duplicate stride samples into full columns).
/// If exceeded, retry with a coarser XZ stride.
const MAX_SAMPLE_BLOCKS: usize = 1_500_000;

/// Max 1×1×1 voxels after horizontal fill. Filled mesh is ~stride² × sparse, so this must be higher
/// than `MAX_SAMPLE_BLOCKS` or we reject almost every stride>1 build and fall back to huge strides
/// (visible gaps / wrong silhouette).
const MAX_EXPORT_BLOCKS: usize = 3_600_000;

/// World Y bounds (1.18+ generation range).
const MIN_Y: i32 = -64;
const MAX_Y: i32 = 320;

type Pos = (i32, i32, i32);

/// Gzip-compressed binary: `u32` vertex count, `N * 3` `f32` positions (centered), `N * 4` `u8` RGBA.
pub fn generate_preview_mesh_gzip(
    world_dir: &Path,
    min_x: i32,
    max_x: i32,
    min_z: i32,
    max_z: i32,
) -> Result<Vec<u8>, String> {
    // Finer steps so we don’t jump straight to huge strides (keeps silhouette closer to the real build).
    const STRIDES: &[u32] = &[1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32];

    let mut last_err = String::new();
    for &stride in STRIDES {
        match collect_solid_blocks(world_dir, min_x, max_x, min_z, max_z, stride) {
            Ok(solid) if solid.is_empty() => {
                last_err = "No solid blocks in selection".to_string();
            }
            Ok(solid) => {
                let filled = if stride <= 1 {
                    solid
                } else {
                    let expanded =
                        expand_stride_samples_to_full_blocks(solid, stride, min_x, max_x, min_z, max_z);
                    if expanded.len() > MAX_EXPORT_BLOCKS {
                        last_err = format!("Too many blocks after filling stride {stride}, trying coarser…");
                        continue;
                    }
                    expanded
                };
                return mesh_to_gzip(&filled);
            }
            Err(e) if e == TOO_MANY_BLOCKS => {
                last_err = format!("Too many blocks at stride {stride}, trying coarser…");
                continue;
            }
            Err(e) => return Err(e),
        }
    }

    Err(if last_err.is_empty() {
        "Could not build 3D preview mesh (area may be too large).".to_string()
    } else {
        last_err
    })
}

const TOO_MANY_BLOCKS: &str = "TOO_MANY_BLOCKS";

/// Each sparse sample at stride `st` represents an `st×st` column footprint. Duplicate it into real
/// 1×1×1 block keys so the mesh is solid Minecraft-sized voxels (no horizontal air gaps).
fn expand_stride_samples_to_full_blocks(
    sparse: HashMap<Pos, Rgb<u8>>,
    stride: u32,
    min_x: i32,
    max_x: i32,
    min_z: i32,
    max_z: i32,
) -> HashMap<Pos, Rgb<u8>> {
    let st = stride.max(1) as i32;
    debug_assert!(st > 1);

    let mut out = HashMap::with_capacity(sparse.len().saturating_mul((st * st) as usize));
    for ((x, y, z), rgb) in sparse {
        for dx in 0..st {
            for dz in 0..st {
                let nx = x + dx;
                let nz = z + dz;
                if nx < min_x || nx > max_x || nz < min_z || nz > max_z {
                    continue;
                }
                out.entry((nx, y, nz)).or_insert(rgb);
            }
        }
    }
    out
}

fn mesh_to_gzip(solid: &HashMap<Pos, Rgb<u8>>) -> Result<Vec<u8>, String> {
    let (positions, colors) = build_mesh_from_solids(solid);
    if positions.is_empty() {
        return Err("No mesh faces generated".to_string());
    }

    let n = positions.len() / 3;
    debug_assert_eq!(colors.len(), n * 4);

    let mut raw = Vec::with_capacity(4 + positions.len() * 4 + colors.len());
    raw.extend_from_slice(&(n as u32).to_le_bytes());
    for p in &positions {
        raw.extend_from_slice(&p.to_le_bytes());
    }
    raw.extend_from_slice(&colors);

    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&raw)
        .map_err(|e| format!("gzip compress: {e}"))?;
    enc.finish().map_err(|e| format!("gzip finish: {e}"))
}

fn collect_solid_blocks(
    world_dir: &Path,
    min_x: i32,
    max_x: i32,
    min_z: i32,
    max_z: i32,
    stride: u32,
) -> Result<HashMap<Pos, Rgb<u8>>, String> {
    let region_dir = world_dir.join("region");
    if !region_dir.is_dir() {
        return Err("No region folder".to_string());
    }

    let min_chunk_x = min_x.div_euclid(16);
    let max_chunk_x = max_x.div_euclid(16);
    let min_chunk_z = min_z.div_euclid(16);
    let max_chunk_z = max_z.div_euclid(16);

    let mut solid: HashMap<Pos, Rgb<u8>> = HashMap::new();
    let st = stride.max(1) as i32;

    for chunk_x in min_chunk_x..=max_chunk_x {
        for chunk_z in min_chunk_z..=max_chunk_z {
            let region_x = chunk_x >> 5;
            let region_z = chunk_z >> 5;
            let rx = chunk_x & 31;
            let rz = chunk_z & 31;

            let region_path = region_dir.join(format!("r.{region_x}.{region_z}.mca"));
            if !region_path.exists() {
                continue;
            }

            let file = match File::open(&region_path) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let mut region = match Region::from_stream(file) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let chunk_data = match region.read_chunk(rx as usize, rz as usize) {
                Ok(Some(d)) => d,
                _ => continue,
            };

            let chunk: Value = match from_bytes(&chunk_data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let sections = get_sections_from_chunk(&chunk);
            let chunk_base_x = chunk_x * 16;
            let chunk_base_z = chunk_z * 16;

            for section in sections {
                let Some(sec_y) = section_y(section) else {
                    continue;
                };
                let sec_y = sec_y as i32;

                for ly in 0..16usize {
                    let wy = sec_y * 16 + ly as i32;
                    if wy < MIN_Y || wy > MAX_Y {
                        continue;
                    }

                    for lx in 0..16usize {
                        let wx = chunk_base_x + lx as i32;
                        if wx < min_x || wx > max_x {
                            continue;
                        }

                        for lz in 0..16usize {
                            let wz = chunk_base_z + lz as i32;
                            if wz < min_z || wz > max_z {
                                continue;
                            }

                            if st > 1
                                && ((wx - min_x).rem_euclid(st) != 0
                                    || (wz - min_z).rem_euclid(st) != 0)
                            {
                                continue;
                            }

                            let Some(name) = block_name_at_local_in_section(section, lx, ly, lz)
                            else {
                                continue;
                            };

                            if is_transparent_block(&name) {
                                continue;
                            }

                            let rgb = rgb_for_block_name(&name);
                            solid.insert((wx, wy, wz), rgb);

                            if solid.len() > MAX_SAMPLE_BLOCKS {
                                return Err(TOO_MANY_BLOCKS.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    if solid.len() > MAX_SAMPLE_BLOCKS {
        return Err(TOO_MANY_BLOCKS.to_string());
    }

    Ok(solid)
}

fn section_y(section: &Value) -> Option<i8> {
    match section {
        Value::Compound(m) => match m.get("Y")? {
            Value::Byte(b) => Some(*b),
            Value::Int(i) => i8::try_from(*i).ok(),
            _ => None,
        },
        _ => None,
    }
}

fn build_mesh_from_solids(solid: &HashMap<Pos, Rgb<u8>>) -> (Vec<f32>, Vec<u8>) {
    let dirs = [
        (1i32, 0i32, 0i32),
        (-1, 0, 0),
        (0, 1, 0),
        (0, -1, 0),
        (0, 0, 1),
        (0, 0, -1),
    ];

    let mut positions = Vec::new();
    let mut colors = Vec::new();

    for (&(x, y, z), &rgb) in solid {
        for (dx, dy, dz) in dirs {
            let nx = x + dx;
            let ny = y + dy;
            let nz = z + dz;
            if solid.contains_key(&(nx, ny, nz)) {
                continue;
            }

            let shade = match (dx, dy, dz) {
                (0, 1, 0) => 1.0f32,
                (0, -1, 0) => 0.52,
                (0, 0, _) | (_, 0, 0) => 0.78,
                _ => 0.78,
            };

            let r = ((rgb.0[0] as f32) * shade).min(255.0) as u8;
            let g = ((rgb.0[1] as f32) * shade).min(255.0) as u8;
            let b = ((rgb.0[2] as f32) * shade).min(255.0) as u8;

            add_face_quad(
                &mut positions,
                &mut colors,
                x,
                y,
                z,
                (dx, dy, dz),
                r,
                g,
                b,
            );
        }
    }

    // Center mesh for stable orbit controls
    if positions.is_empty() {
        return (positions, colors);
    }

    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut min_z = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    let mut max_z = f32::MIN;
    for p in positions.chunks_exact(3) {
        min_x = min_x.min(p[0]);
        min_y = min_y.min(p[1]);
        min_z = min_z.min(p[2]);
        max_x = max_x.max(p[0]);
        max_y = max_y.max(p[1]);
        max_z = max_z.max(p[2]);
    }

    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    let cz = (min_z + max_z) * 0.5;

    for p in positions.chunks_exact_mut(3) {
        p[0] -= cx;
        p[1] -= cy;
        p[2] -= cz;
    }

    (positions, colors)
}

/// Add two triangles for the face between this block and air (outward normal = dir).
fn add_face_quad(
    positions: &mut Vec<f32>,
    colors: &mut Vec<u8>,
    bx: i32,
    by: i32,
    bz: i32,
    dir: (i32, i32, i32),
    r: u8,
    g: u8,
    b: u8,
) {
    let x0 = bx as f32;
    let y0 = by as f32;
    let z0 = bz as f32;
    let x1 = x0 + 1.0;
    let y1 = y0 + 1.0;
    let z1 = z0 + 1.0;

    match dir {
        (1, 0, 0) => {
            // +X
            push_tri(positions, colors, r, g, b, x1, y0, z0, x1, y1, z0, x1, y1, z1);
            push_tri(positions, colors, r, g, b, x1, y0, z0, x1, y1, z1, x1, y0, z1);
        }
        (-1, 0, 0) => {
            push_tri(positions, colors, r, g, b, x0, y0, z1, x0, y1, z1, x0, y1, z0);
            push_tri(positions, colors, r, g, b, x0, y0, z1, x0, y1, z0, x0, y0, z0);
        }
        (0, 1, 0) => {
            // +Y top
            push_tri(positions, colors, r, g, b, x0, y1, z0, x1, y1, z0, x1, y1, z1);
            push_tri(positions, colors, r, g, b, x0, y1, z0, x1, y1, z1, x0, y1, z1);
        }
        (0, -1, 0) => {
            push_tri(positions, colors, r, g, b, x0, y0, z1, x1, y0, z1, x1, y0, z0);
            push_tri(positions, colors, r, g, b, x0, y0, z1, x1, y0, z0, x0, y0, z0);
        }
        (0, 0, 1) => {
            push_tri(positions, colors, r, g, b, x0, y0, z1, x0, y1, z1, x1, y1, z1);
            push_tri(positions, colors, r, g, b, x0, y0, z1, x1, y1, z1, x1, y0, z1);
        }
        (0, 0, -1) => {
            push_tri(positions, colors, r, g, b, x1, y0, z0, x1, y1, z0, x0, y1, z0);
            push_tri(positions, colors, r, g, b, x1, y0, z0, x0, y1, z0, x0, y0, z0);
        }
        _ => {}
    }
}

fn push_tri(
    positions: &mut Vec<f32>,
    colors: &mut Vec<u8>,
    r: u8,
    g: u8,
    b: u8,
    ax: f32,
    ay: f32,
    az: f32,
    bx: f32,
    by: f32,
    bz: f32,
    cx: f32,
    cy: f32,
    cz: f32,
) {
    for (x, y, z) in [(ax, ay, az), (bx, by, bz), (cx, cy, cz)] {
        positions.extend_from_slice(&[x, y, z]);
        colors.extend_from_slice(&[r, g, b, 255]);
    }
}
