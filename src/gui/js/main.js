import { licenseText } from './license.js';
import { fetchLanguage, invalidJSON } from './language.js';

let invoke;
if (window.__TAURI__) {
  invoke = window.__TAURI__.core.invoke;
} else {
  function dummyFunc() { }
  window.__TAURI__ = { event: { listen: dummyFunc } };
  invoke = dummyFunc;
}

const DEFAULT_LOCALE_PATH = `./locales/en.json`;

// Track current bbox selection info localization key for language changes
let currentBboxSelectionKey = "select_area_prompt";
let currentBboxSelectionColor = "#ffffff";

// Helper function to set bbox selection info text and track it for language changes
async function setBboxSelectionInfo(bboxSelectionElement, localizationKey, color) {
  currentBboxSelectionKey = localizationKey;
  currentBboxSelectionColor = color;
  
  // Ensure localization is available
  let localization = window.localization;
  if (!localization) {
    localization = await getLocalization();
  }
  
  localizeElement(localization, { element: bboxSelectionElement }, localizationKey);
  bboxSelectionElement.style.color = color;
}

// Initialize elements and start the demo progress
window.addEventListener("DOMContentLoaded", async () => {
  registerMessageEvent();
  window.createWorld = createWorld;
  window.startGeneration = startGeneration;
  window.closeWorldPreviewModal = closeWorldPreviewModal;
  window.openWorldPreview = openWorldPreview;
  initWorldPreviewModal();
  setupProgressListener();
  await initSavePath();
  initSettings();
  initTelemetryConsent();
  handleBboxInput();
  const localization = await getLocalization();
  await applyLocalization(localization);
  updateFormatToggleUI(selectedWorldFormat);
  initFooter();
  await checkForUpdates();
});

// Expose language functions to window for use by language-selector.js
window.fetchLanguage = fetchLanguage;
window.applyLocalization = applyLocalization;
window.initFooter = initFooter;

/**
 * Fetches and returns localization data based on user's language
 * Falls back to English if requested language is not available
 * @returns {Promise<Object>} The localization JSON object
 */
async function getLocalization() {
  // Check if user has a saved language preference
  const savedLanguage = localStorage.getItem('arnis-language');

  // If there's a saved preference, use it
  if (savedLanguage) {
    return await fetchLanguage(savedLanguage);
  }

  // Otherwise use the browser's language
  const lang = navigator.language;
  return await fetchLanguage(lang);
}

/**
 * Updates an HTML element with localized text
 * @param {Object} json - Localization data
 * @param {Object} elementObject - Object containing element or selector
 * @param {string} localizedStringKey - Key for the localized string
 */
async function localizeElement(json, elementObject, localizedStringKey) {
  const element =
    (!elementObject.element || elementObject.element === "")
      ? document.querySelector(elementObject.selector) : elementObject.element;
  const attribute = localizedStringKey.startsWith("placeholder_") ? "placeholder" : "textContent";

  if (element) {
    if (json && localizedStringKey in json) {
      element[attribute] = json[localizedStringKey];
    } else {
      // Fallback to default (English) string
      const defaultJson = await fetchLanguage('en');
      element[attribute] = defaultJson[localizedStringKey];
    }
  }
}

async function applyLocalization(localization) {
  const localizationElements = {
    "span[id='choose_world']": "create_world",
    "span[id='import_world']": "import_world",
    "#selected-world": "no_world_selected",
    "#start-button": "start_generation",
    "#preview-button": "world_preview_open_btn",
    "h2[data-localize='customization_settings']": "customization_settings",
    "span[data-localize='world_scale']": "world_scale",
    "span[data-localize='custom_bounding_box']": "custom_bounding_box",
    // DEPRECATED: Ground level localization removed
    // "label[data-localize='ground_level']": "ground_level",
    "span[data-localize='language']": "language",
    "span[data-localize='generation_mode']": "generation_mode",
    "option[data-localize='mode_geo_terrain']": "mode_geo_terrain",
    "option[data-localize='mode_geo_only']": "mode_geo_only",
    "option[data-localize='mode_terrain_only']": "mode_terrain_only",
    "span[data-localize='terrain']": "terrain",
    "span[data-localize='interior']": "interior",
    "span[data-localize='roof']": "roof",
    "span[data-localize='fillground']": "fillground",
    "span[data-localize='city_boundaries']": "city_boundaries",
    "span[data-localize='map_theme']": "map_theme",
    "span[data-localize='save_path']": "save_path",
    ".footer-credits": "footer_text",
    "button[data-localize='license_and_credits']": "license_and_credits",
    "h2[data-localize='license_and_credits']": "license_and_credits",
    "#world-preview-title": "world_preview_title",
    "#world-preview-hint": "world_preview_hint",
    "#world-preview-tab-2d": "world_preview_tab_2d",
    "#world-preview-tab-3d": "world_preview_tab_3d",
    "#world-preview-close-btn": "world_preview_close",

    // Placeholder strings
    "input[id='bbox-coords']": "placeholder_bbox",
    // DEPRECATED: Ground level placeholder removed
    // "input[id='ground-level']": "placeholder_ground"
  };

  for (const selector in localizationElements) {
    localizeElement(localization, { selector: selector }, localizationElements[selector]);
  }

  // Re-apply current bbox selection info text with new language
  const bboxSelectionInfo = document.getElementById("bbox-selection-info");
  if (bboxSelectionInfo && currentBboxSelectionKey) {
    localizeElement(localization, { element: bboxSelectionInfo }, currentBboxSelectionKey);
    bboxSelectionInfo.style.color = currentBboxSelectionColor;
  }

  // Update error messages
  window.localization = localization;
}

// Function to initialize the footer with the current year and version
async function initFooter() {
  const currentYear = new Date().getFullYear();
  let version = "x.x.x";

  try {
    version = await invoke('gui_get_version');
  } catch (error) {
    console.error("Failed to fetch version:", error);
  }

  const footerElement = document.querySelector(".footer-credits");
  if (footerElement) {
    // Get the original text from localization if available, or use the current text
    let footerText = footerElement.textContent;

    // Check if the text is from localization and contains placeholders
    if (window.localization && window.localization.footer_text) {
      footerText = window.localization.footer_text;
    }

    // Replace placeholders with actual values
    footerElement.textContent = footerText
      .replace("{year}", currentYear)
      .replace("{version}", version);
  }
}

// Function to check for updates and display a notification if available
async function checkForUpdates() {
  try {
    const isUpdateAvailable = await invoke('gui_check_for_updates');
    if (isUpdateAvailable) {
      const footer = document.querySelector(".footer");
      const updateMessage = document.createElement("a");
      updateMessage.href = "https://github.com/louis-e/arnis/releases";
      updateMessage.target = "_blank";
      updateMessage.style.color = "#fecc44";
      updateMessage.style.marginTop = "-5px";
      updateMessage.style.fontSize = "0.95em";
      updateMessage.style.display = "block";
      updateMessage.style.textDecoration = "none";

      localizeElement(window.localization, { element: updateMessage }, "new_version_available");
      footer.style.marginTop = "10px";
      footer.appendChild(updateMessage);
    }
  } catch (error) {
    console.error("Failed to check for updates: ", error);
  }
}

// Function to register the event listener for bbox updates from iframe
function registerMessageEvent() {
  window.addEventListener('message', function (event) {
    const bboxText = event.data.bboxText;

    if (bboxText) {
      console.log("Updated BBOX Coordinates:", bboxText);
      displayBboxInfoText(bboxText);
    }
  });
}

// Function to set up the progress bar listener
function setupProgressListener() {
  const progressBar = document.getElementById("progress-bar");
  const progressInfo = document.getElementById("progress-info");
  const progressDetail = document.getElementById("progress-detail");

  window.__TAURI__.event.listen("progress-update", (event) => {
    const { progress, message } = event.payload;

    if (progress != -1) {
      progressBar.style.width = `${progress}%`;
      progressDetail.textContent = `${Math.round(progress)}%`;
    }

    if (message != "") {
      progressInfo.textContent = message;

      if (message.startsWith("Error!")) {
        progressInfo.style.color = "#fa7878";
        generationButtonEnabled = true;
      } else if (message.startsWith("Done!")) {
        progressInfo.style.color = "#7bd864";
        generationButtonEnabled = true;
      } else {
        progressInfo.style.color = "#ececec";
      }
    }
  });

  // Listen for map preview ready event from backend
  window.__TAURI__.event.listen("map-preview-ready", () => {
    console.log("Map preview ready event received");
    showWorldPreviewButton();
  });

  // Listen for open-mcworld-file event to show the generated Bedrock world in file explorer
  window.__TAURI__.event.listen("open-mcworld-file", async (event) => {
    const filePath = event.payload;
    try {
      // Use our custom command to show the file in the system file explorer
      await invoke("gui_show_in_folder", { path: filePath });
    } catch (error) {
      console.error("Failed to show mcworld file in folder:", error);
    }
  });
}

function initSettings() {
  // Settings
  const settingsModal = document.getElementById("settings-modal");
  const slider = document.getElementById("scale-value-slider");
  const sliderValue = document.getElementById("slider-value");

  // Open settings modal
  function openSettings() {
    settingsModal.style.display = "flex";
    settingsModal.style.justifyContent = "center";
    settingsModal.style.alignItems = "center";
  }

  // Close settings modal
  function closeSettings() {
    settingsModal.style.display = "none";
  }

  // Close settings and license modals on escape key
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (settingsModal.style.display === "flex") {
        closeSettings();
      }
      
      const licenseModal = document.getElementById("license-modal");
      if (licenseModal && licenseModal.style.display === "flex") {
        closeLicense();
      }

      const worldPreviewModal = document.getElementById("world-preview-modal");
      if (worldPreviewModal && worldPreviewModal.style.display === "flex") {
        closeWorldPreviewModal();
      }
    }
  });

  window.openSettings = openSettings;
  window.closeSettings = closeSettings;

  // Update slider value display
  slider.addEventListener("input", () => {
    sliderValue.textContent = parseFloat(slider.value).toFixed(2);
  });

  // World format toggle (Java/Bedrock)
  initWorldFormatToggle();

  // Save path setting
  initSavePathSetting();

  // Language selector
  const languageSelect = document.getElementById("language-select");
  const availableOptions = Array.from(languageSelect.options).map(opt => opt.value);
  
  // Check for saved language preference first
  const savedLanguage = localStorage.getItem('arnis-language');
  let languageToSet = 'en'; // Default to English
  
  if (savedLanguage && availableOptions.includes(savedLanguage)) {
    // Use saved language if it exists and is available
    languageToSet = savedLanguage;
  } else {
    // Otherwise use browser language
    const currentLang = navigator.language;
    
    // Try to match the exact language code first
    if (availableOptions.includes(currentLang)) {
      languageToSet = currentLang;
    }
    // Try to match just the base language code
    else if (availableOptions.includes(currentLang.split('-')[0])) {
      languageToSet = currentLang.split('-')[0];
    }
    // languageToSet remains 'en' as default
  }
  
  languageSelect.value = languageToSet;

  // Handle language change
  languageSelect.addEventListener("change", async () => {
    const selectedLanguage = languageSelect.value;

    // Store the selected language in localStorage for persistence
    localStorage.setItem('arnis-language', selectedLanguage);

    // Reload localization with the new language
    const localization = await fetchLanguage(selectedLanguage);
    await applyLocalization(localization);

    // Restore correct #selected-world text after localization overwrites it
    updateFormatToggleUI(selectedWorldFormat);
    // If a world was already created, show its name
    if (worldPath) {
      const lastSegment = worldPath.split(/[\\/]/).pop();
      document.getElementById('selected-world').textContent = lastSegment;
    }
  });

  // Tile theme selector
  const tileThemeSelect = document.getElementById("tile-theme-select");

  // Load saved tile theme preference
  const savedTileTheme = localStorage.getItem('selectedTileTheme') || 'osm';
  tileThemeSelect.value = savedTileTheme;

  // Handle tile theme change
  tileThemeSelect.addEventListener("change", () => {
    const selectedTheme = tileThemeSelect.value;

    // Store the selected theme in localStorage for persistence
    localStorage.setItem('selectedTileTheme', selectedTheme);

    // Send message to map iframe to change tile theme
    const mapIframe = document.querySelector('iframe[src="maps.html"]');
    if (mapIframe && mapIframe.contentWindow) {
      mapIframe.contentWindow.postMessage({
        type: 'changeTileTheme',
        theme: selectedTheme
      }, '*');
    }
  });

  // Telemetry consent toggle
  const telemetryToggle = document.getElementById("telemetry-toggle");
  const telemetryKey = 'telemetry-consent';

  // Load saved telemetry consent
  const savedConsent = localStorage.getItem(telemetryKey);
  telemetryToggle.checked = savedConsent === 'true';

  // Handle telemetry consent change
  telemetryToggle.addEventListener("change", () => {
    const isEnabled = telemetryToggle.checked;
    localStorage.setItem(telemetryKey, isEnabled ? 'true' : 'false');
  });


  /// License and Credits
  function openLicense() {
    const licenseModal = document.getElementById("license-modal");
    const licenseContent = document.getElementById("license-content");

    // Render the license text as HTML
    licenseContent.innerHTML = licenseText;

    // Show the modal
    licenseModal.style.display = "flex";
    licenseModal.style.justifyContent = "center";
    licenseModal.style.alignItems = "center";
  }

  function closeLicense() {
    const licenseModal = document.getElementById("license-modal");
    licenseModal.style.display = "none";
  }

  window.openLicense = openLicense;
  window.closeLicense = closeLicense;
}

// World format selection (Java/Bedrock)
let selectedWorldFormat = 'java'; // Default to Java

function initWorldFormatToggle() {
  // Load saved format preference
  const savedFormat = localStorage.getItem('arnis-world-format');
  if (savedFormat && (savedFormat === 'java' || savedFormat === 'bedrock')) {
    selectedWorldFormat = savedFormat;
  }
  
  // Apply the saved selection to UI
  updateFormatToggleUI(selectedWorldFormat);
}

function setWorldFormat(format) {
  if (format !== 'java' && format !== 'bedrock') return;
  
  selectedWorldFormat = format;
  localStorage.setItem('arnis-world-format', format);
  updateFormatToggleUI(format);
}

function updateFormatToggleUI(format) {
  const javaBtn = document.getElementById('format-java');
  const bedrockBtn = document.getElementById('format-bedrock');
  const chooseWorldBtn = document.getElementById('choose-world-btn');
  const selectedWorldText = document.getElementById('selected-world');
  
  if (format === 'java') {
    javaBtn.classList.add('format-active');
    bedrockBtn.classList.remove('format-active');
    // Enable Create World button for Java
    if (chooseWorldBtn) {
      chooseWorldBtn.disabled = false;
      chooseWorldBtn.style.opacity = '1';
      chooseWorldBtn.style.cursor = 'pointer';
    }
    // Show appropriate text based on whether a world was already created
    if (selectedWorldText && !worldPath) {
      const noWorldText = window.localization?.no_world_selected || 'No world created';
      selectedWorldText.textContent = noWorldText;
      selectedWorldText.style.color = '#fecc44';
    }
    updatePreviewButtonEnabled();
  } else {
    javaBtn.classList.remove('format-active');
    bedrockBtn.classList.add('format-active');
    // Disable Create World button for Bedrock
    if (chooseWorldBtn) {
      chooseWorldBtn.disabled = true;
      chooseWorldBtn.style.opacity = '0.5';
      chooseWorldBtn.style.cursor = 'not-allowed';
    }
    // Clear world selection and show Bedrock info message
    worldPath = "";
    if (selectedWorldText) {
      const bedrockText = window.localization?.bedrock_auto_generated || 'Bedrock world is auto-generated';
      selectedWorldText.textContent = bedrockText;
      selectedWorldText.style.color = '#fecc44';
    }
    updatePreviewButtonEnabled();
  }
}

// Expose to window for onclick handlers
window.setWorldFormat = setWorldFormat;

// Telemetry consent (first run only)
function initTelemetryConsent() {
  const key = 'telemetry-consent'; // values: 'true' | 'false'
  const existing = localStorage.getItem(key);

  const modal = document.getElementById('telemetry-modal');
  if (!modal) return;

  if (existing === null) {
    // First run: ask for consent
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';
  }

  // Expose handlers
  window.acceptTelemetry = () => {
    localStorage.setItem(key, 'true');
    modal.style.display = 'none';
    // Update settings toggle to reflect the consent
    const telemetryToggle = document.getElementById('telemetry-toggle');
    if (telemetryToggle) {
      telemetryToggle.checked = true;
    }
  };

  window.rejectTelemetry = () => {
    localStorage.setItem(key, 'false');
    modal.style.display = 'none';
    // Update settings toggle to reflect the consent
    const telemetryToggle = document.getElementById('telemetry-toggle');
    if (telemetryToggle) {
      telemetryToggle.checked = false;
    }
  };

  // Utility for other scripts to read consent
  window.getTelemetryConsent = () => {
    const v = localStorage.getItem(key);
    return v === null ? null : v === 'true';
  };
}

/// Save path management
let savePath = "";

async function initSavePath() {
  // Check if user has a saved path in localStorage
  const saved = localStorage.getItem('arnis-save-path');
  if (saved) {
    // Validate the saved path still exists (handles upgrades / moved directories)
    try {
      const normalized = await invoke('gui_set_save_path', { path: saved });
      savePath = normalized;
      localStorage.setItem('arnis-save-path', savePath);
    } catch (_) {
      // Saved path is no longer valid – re-detect
      console.warn("Stored save path no longer valid, re-detecting...");
      localStorage.removeItem('arnis-save-path');
      try {
        savePath = await invoke('gui_get_default_save_path');
        localStorage.setItem('arnis-save-path', savePath);
      } catch (error) {
        console.error("Failed to detect save path:", error);
      }
    }
  } else {
    // Auto-detect on first run
    try {
      savePath = await invoke('gui_get_default_save_path');
      localStorage.setItem('arnis-save-path', savePath);
    } catch (error) {
      console.error("Failed to detect save path:", error);
    }
  }

  // Populate the save path input in settings
  const savePathInput = document.getElementById('save-path-input');
  if (savePathInput) {
    savePathInput.value = savePath;
  }
}

function initSavePathSetting() {
  const savePathInput = document.getElementById('save-path-input');
  if (!savePathInput) return;

  savePathInput.value = savePath;

  // Manual text input – validate on change, revert if invalid
  savePathInput.addEventListener('change', async () => {
    const newPath = savePathInput.value.trim();
    if (!newPath) {
      savePathInput.value = savePath;
      return;
    }

    try {
      const validated = await invoke('gui_set_save_path', { path: newPath });
      savePath = validated;
      localStorage.setItem('arnis-save-path', savePath);
    } catch (_) {
      // Invalid path – silently revert to previous value
      savePathInput.value = savePath;
    }
  });

  // Folder picker button
  const browseBtn = document.getElementById('save-path-browse');
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      try {
        const picked = await invoke('gui_pick_save_directory', { startPath: savePath });
        if (picked) {
          savePath = picked;
          savePathInput.value = savePath;
          localStorage.setItem('arnis-save-path', savePath);
        }
      } catch (error) {
        console.error("Folder picker failed:", error);
      }
    });
  }
}

/**
 * Validates and processes bounding box coordinates input
 * Supports both comma and space-separated formats
 * Updates the map display when valid coordinates are entered
 */
function handleBboxInput() {
  const inputBox = document.getElementById("bbox-coords");
  const bboxSelectionInfo = document.getElementById("bbox-selection-info");

  inputBox.addEventListener("input", function () {
    const input = inputBox.value.trim();

    if (input === "") {
      // Empty input - revert to map selection if available
      customBBoxValid = false;
      selectedBBox = mapSelectedBBox;
      
      // Clear the info text only if no map selection exists
      if (!mapSelectedBBox) {
        setBboxSelectionInfo(bboxSelectionInfo, "select_area_prompt", "#ffffff");
      } else {
        // Restore map selection info display but don't update input field
        const [lng1, lat1, lng2, lat2] = mapSelectedBBox.split(" ").map(Number);
        const selectedSize = calculateBBoxSize(lng1, lat1, lng2, lat2);
        displayBboxSizeStatus(bboxSelectionInfo, selectedSize);
      }
      return;
    }

    // Regular expression to validate bbox input (supports both comma and space-separated formats)
    const bboxPattern = /^(-?\d+(\.\d+)?)[,\s](-?\d+(\.\d+)?)[,\s](-?\d+(\.\d+)?)[,\s](-?\d+(\.\d+)?)$/;

    if (bboxPattern.test(input)) {
      const matches = input.match(bboxPattern);

      // Extract coordinates (Lat / Lng order expected)
      const lat1 = parseFloat(matches[1]);
      const lng1 = parseFloat(matches[3]);
      const lat2 = parseFloat(matches[5]);
      const lng2 = parseFloat(matches[7]);

      // Validate latitude and longitude ranges in the expected Lat / Lng order
      if (
        lat1 >= -90 && lat1 <= 90 &&
        lng1 >= -180 && lng1 <= 180 &&
        lat2 >= -90 && lat2 <= 90 &&
        lng2 >= -180 && lng2 <= 180
      ) {
        // Input is valid; trigger the event with consistent comma-separated format
        const bboxText = `${lat1},${lng1},${lat2},${lng2}`;
        window.dispatchEvent(new MessageEvent('message', { data: { bboxText } }));

        // Show custom bbox on the map
        let map_container = document.querySelector('.map-container');
        map_container.setAttribute('src', `maps.html#${lat1},${lng1},${lat2},${lng2}`);
        map_container.contentWindow.location.reload();

        // Update the info text and mark custom input as valid
        customBBoxValid = true;
        selectedBBox = bboxText.replace(/,/g, ' '); // Convert to space format for consistency
        setBboxSelectionInfo(bboxSelectionInfo, "custom_selection_confirmed", "#7bd864");
      } else {
        // Valid numbers but invalid order or range
        customBBoxValid = false;
        // Don't clear selectedBBox - keep map selection if available
        if (!mapSelectedBBox) {
          selectedBBox = "";
        } else {
          selectedBBox = mapSelectedBBox;
        }
        setBboxSelectionInfo(bboxSelectionInfo, "error_coordinates_out_of_range", "#fecc44");
      }
    } else {
      // Input doesn't match the required format
      customBBoxValid = false;
      // Don't clear selectedBBox - keep map selection if available
      if (!mapSelectedBBox) {
        selectedBBox = "";
      } else {
        selectedBBox = mapSelectedBBox;
      }
      setBboxSelectionInfo(bboxSelectionInfo, "invalid_format", "#fecc44");
    }
  });
}

/**
 * Calculates the approximate area of a bounding box in square meters
 * Uses the Haversine formula for geodesic calculations
 * @param {number} lng1 - First longitude coordinate
 * @param {number} lat1 - First latitude coordinate
 * @param {number} lng2 - Second longitude coordinate
 * @param {number} lat2 - Second latitude coordinate
 * @returns {number} Area in square meters
 */
function calculateBBoxSize(lng1, lat1, lng2, lat2) {
  // Approximate distance calculation using Haversine formula or geodesic formula
  const toRad = (angle) => (angle * Math.PI) / 180;
  const R = 6371000; // Earth radius in meters

  const latDistance = toRad(lat2 - lat1);
  const lngDistance = toRad(lng2 - lng1);

  const a = Math.sin(latDistance / 2) * Math.sin(latDistance / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(lngDistance / 2) * Math.sin(lngDistance / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Width and height of the box
  const height = R * latDistance;
  const width = R * lngDistance;

  return Math.abs(width * height);
}

/**
 * Normalizes a longitude value to the range [-180, 180]
 * @param {number} lon - Longitude value to normalize
 * @returns {number} Normalized longitude value
 */
function normalizeLongitude(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

const threshold1 = 44000000.00;  // Yellow warning threshold (~6.2km x 7km)
const threshold2 = 85000000.00;  // Red error threshold (~8.7km x 9.8km)
const threshold3 = 500000000.00; // Extreme warning threshold (500 km²)
let selectedBBox = "";
let mapSelectedBBox = "";  // Tracks bbox from map selection
let customBBoxValid = false;  // Tracks if custom input is valid

/**
 * Displays the appropriate bbox size status message based on area thresholds
 * @param {HTMLElement} bboxSelectionElement - The element to display the message in
 * @param {number} selectedSize - The calculated bbox area in square meters
 */
function displayBboxSizeStatus(bboxSelectionElement, selectedSize) {
  if (selectedSize > threshold3) {
    setBboxSelectionInfo(bboxSelectionElement, "area_extreme", "#ff4444");
  } else if (selectedSize > threshold2) {
    setBboxSelectionInfo(bboxSelectionElement, "area_too_large", "#fa7878");
  } else if (selectedSize > threshold1) {
    setBboxSelectionInfo(bboxSelectionElement, "area_extensive", "#fecc44");
  } else {
    setBboxSelectionInfo(bboxSelectionElement, "selection_confirmed", "#7bd864");
  }
}

// Function to handle incoming bbox data
function displayBboxInfoText(bboxText) {
  let [lng1, lat1, lng2, lat2] = bboxText.split(" ").map(Number);

  // Normalize longitudes
  lat1 = parseFloat(normalizeLongitude(lat1).toFixed(6));
  lat2 = parseFloat(normalizeLongitude(lat2).toFixed(6));
  mapSelectedBBox = `${lng1} ${lat1} ${lng2} ${lat2}`;
  
  // Map selection always takes priority - clear custom input and update selectedBBox
  selectedBBox = mapSelectedBBox;
  customBBoxValid = false;

  const bboxSelectionInfo = document.getElementById("bbox-selection-info");
  const bboxCoordsInput = document.getElementById("bbox-coords");

  // Reset the info text if the bbox is 0,0,0,0
  if (lng1 === 0 && lat1 === 0 && lng2 === 0 && lat2 === 0) {
    setBboxSelectionInfo(bboxSelectionInfo, "select_area_prompt", "#ffffff");
    bboxCoordsInput.value = "";
    mapSelectedBBox = "";
    if (!customBBoxValid) {
      selectedBBox = "";
    }
    return;
  }

  // Update the custom bbox input with the map selection (comma-separated format)
  bboxCoordsInput.value = `${lng1},${lat1},${lng2},${lat2}`;

  // Calculate the size of the selected bbox
  const selectedSize = calculateBBoxSize(lng1, lat1, lng2, lat2);

  displayBboxSizeStatus(bboxSelectionInfo, selectedSize);
}

let worldPath = "";

async function createWorld() {
  // Don't create if format is Bedrock (button should be disabled)
  if (selectedWorldFormat === 'bedrock') return;

  // Don't create if save path hasn't been initialized
  if (!savePath) {
    console.warn("Cannot create world: save path not set");
    return;
  }

  try {
    const worldName = await invoke('gui_create_world', { savePath: savePath });
    if (worldName) {
      worldPath = worldName;
      const lastSegment = worldName.split(/[\\/]/).pop();
      document.getElementById('selected-world').textContent = lastSegment;
      document.getElementById('selected-world').style.color = "#fecc44";

      // Notify that world changed (reset preview)
      notifyWorldChanged();
      updatePreviewButtonEnabled();
    }
  } catch (error) {
    handleWorldSelectionError(error);
  }
}

/**
 * Handles world selection errors and displays appropriate messages
 * @param {number} errorCode - Error code from the backend
 */
function handleWorldSelectionError(errorCode) {
  const errorKeys = {
    1: "minecraft_directory_not_found",
    2: "world_in_use",
    3: "failed_to_create_world",
    4: "no_world_selected_error"
  };

  const errorKey = errorKeys[errorCode] || "unknown_error";
  const selectedWorld = document.getElementById('selected-world');
  localizeElement(window.localization, { element: selectedWorld }, errorKey);
  selectedWorld.style.color = "#fa7878";
  worldPath = "";
  console.error(errorCode);
}

let generationButtonEnabled = true;
/**
 * Initiates the world generation process
 * Validates required inputs and sends generation parameters to the backend
 * @returns {Promise<void>}
 */
async function startGeneration() {
  try {
    if (generationButtonEnabled === false) {
      return;
    }

    if (!selectedBBox || selectedBBox == "0.000000 0.000000 0.000000 0.000000") {
      const bboxSelectionInfo = document.getElementById('bbox-selection-info');
      setBboxSelectionInfo(bboxSelectionInfo, "select_location_first", "#fa7878");
      return;
    }

    // Only require world creation for Java format (Bedrock generates a new .mcworld file)
    if (selectedWorldFormat === 'java' && (!worldPath || worldPath === "")) {
      const selectedWorld = document.getElementById('selected-world');
      localizeElement(window.localization, { element: selectedWorld }, "create_world_first");
      selectedWorld.style.color = "#fa7878";
      return;
    }

    // Clear any existing world preview since we're generating a new one
    notifyWorldChanged();

    // Get the map iframe reference
    const mapFrame = document.querySelector('.map-container');
    // Get spawn point coordinates if marker exists
    let spawnPoint = null;
    if (mapFrame && mapFrame.contentWindow && mapFrame.contentWindow.getSpawnPointCoords) {
      const coords = mapFrame.contentWindow.getSpawnPointCoords();
      // Convert object format to tuple format if coordinates exist
      if (coords) {
        spawnPoint = [coords.lat, coords.lng];
      }
    }

    // Get generation mode from dropdown
    var generationMode = document.getElementById("generation-mode-select").value;
    var terrain = (generationMode === "geo-terrain" || generationMode === "terrain-only");
    var skipOsmObjects = (generationMode === "terrain-only");

    var interior = document.getElementById("interior-toggle").checked;
    var roof = document.getElementById("roof-toggle").checked;
    var fill_ground = document.getElementById("fillground-toggle").checked;
    var city_boundaries = document.getElementById("city-boundaries-toggle").checked;
    var scale = parseFloat(document.getElementById("scale-value-slider").value);
    // var ground_level = parseInt(document.getElementById("ground-level").value, 10);
    // DEPRECATED: Ground level input removed from UI
    var ground_level = -62;

    // Validate ground_level
    ground_level = isNaN(ground_level) || ground_level < -62 ? -62 : ground_level;

    // Get telemetry consent (defaults to false if not set)
    const telemetryConsent = window.getTelemetryConsent ? window.getTelemetryConsent() : false;

    // Pass the selected options to the Rust backend
    await invoke("gui_start_generation", {
        bboxText: selectedBBox,
        selectedWorld: worldPath,
        worldScale: scale,
        groundLevel: ground_level,
        terrainEnabled: terrain,
        skipOsmObjects: skipOsmObjects,
        interiorEnabled: interior,
        roofEnabled: roof,
        fillgroundEnabled: fill_ground,
        cityBoundariesEnabled: city_boundaries,
        isNewWorld: true,
        spawnPoint: spawnPoint,
        telemetryConsent: telemetryConsent || false,
        worldFormat: selectedWorldFormat
    });

    console.log("Generation process started.");
    generationButtonEnabled = false;
  } catch (error) {
    console.error("Error starting generation:", error);
    generationButtonEnabled = true;
  }
}

// World preview overlay state
let worldPreviewEnabled = false;
let currentWorldMapData = null;
/** @type {string|null} */
let worldPreviewMeshGzipB64 = null;
/** @type {string|null} */
let importPreviewWorldPath = null;

/** 2D modal map zoom (1 = fit width). */
let worldPreview2dZoom = 1;

/** Base64 zip for Tauri invoke — uses browser DataURL path (much faster than JS byte→string loops). */
function fileToBase64DataUrlTail(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result;
      if (typeof s !== 'string') {
        reject(new Error('Read failed'));
        return;
      }
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = () => reject(r.error || new Error('Read failed'));
    r.readAsDataURL(file);
  });
}

async function importZipAndPreview(file, statusElement) {
  if (!file) return;
  if (statusElement) {
    statusElement.style.color = '#9ecbff';
    statusElement.textContent = 'Reading zip…';
  }

  const zipBase64 = await fileToBase64DataUrlTail(file);

  if (statusElement) statusElement.textContent = 'Building preview…';
  const preview = await invoke('gui_build_import_preview_from_zip_base64', { zipBase64 });
  if (!preview || !preview.image_base64) {
    throw new Error('Could not build preview from zip');
  }

  currentWorldMapData = {
    image_base64: preview.image_base64,
    min_mc_x: preview.min_mc_x || 0,
    max_mc_x: preview.max_mc_x || 0,
    min_mc_z: preview.min_mc_z || 0,
    max_mc_z: preview.max_mc_z || 0,
    min_lat: 0,
    max_lat: 0,
    min_lon: 0,
    max_lon: 0,
  };
  worldPreviewMeshGzipB64 = null;
  importPreviewWorldPath = preview.world_path || null;

  const meshWp = importPreviewWorldPath;
  if (meshWp) {
    const pullMeshCache = async () => {
      try {
        const m = await invoke('gui_get_world_preview_mesh_gzip_base64', { worldPath: meshWp });
        if (m) worldPreviewMeshGzipB64 = m;
      } catch (_) {}
    };
    void pullMeshCache();
    window.setTimeout(pullMeshCache, 1200);
    window.setTimeout(pullMeshCache, 4000);
  }

  const mapFrame = document.querySelector('.map-container');
  if (mapFrame && mapFrame.contentWindow) {
    mapFrame.contentWindow.postMessage({
      type: 'worldPreviewReady',
      data: currentWorldMapData
    }, '*');
  }

  openWorldPreviewModal(currentWorldMapData.image_base64);
  if (statusElement) {
    statusElement.style.color = '#8de38d';
    statusElement.textContent = 'Imported. Preview ready.';
  }
}

function applyWorldPreview2dZoom() {
  const img = document.getElementById('world-preview-modal-img');
  const label = document.getElementById('world-preview-zoom-label');
  if (!img) return;
  img.style.width = `${worldPreview2dZoom * 100}%`;
  img.style.maxWidth = 'none';
  if (label) {
    label.textContent = `${Math.round(worldPreview2dZoom * 100)}%`;
  }
}

function resetWorldPreview2dZoom() {
  worldPreview2dZoom = 1;
  const wrap = document.getElementById('world-preview-img-wrap');
  applyWorldPreview2dZoom();
  if (wrap) {
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
  }
}

function initWorldPreview2dZoom() {
  if (initWorldPreview2dZoom._inited) return;
  initWorldPreview2dZoom._inited = true;
  const wrap = document.getElementById('world-preview-img-wrap');
  const btnIn = document.getElementById('world-preview-zoom-in');
  const btnOut = document.getElementById('world-preview-zoom-out');
  const btnReset = document.getElementById('world-preview-zoom-reset');
  if (!wrap || !btnIn || !btnOut || !btnReset) return;

  btnIn.addEventListener('click', () => {
    worldPreview2dZoom = Math.min(6, worldPreview2dZoom * 1.2);
    applyWorldPreview2dZoom();
  });
  btnOut.addEventListener('click', () => {
    worldPreview2dZoom = Math.max(0.2, worldPreview2dZoom / 1.2);
    applyWorldPreview2dZoom();
  });
  btnReset.addEventListener('click', () => resetWorldPreview2dZoom());

  wrap.addEventListener(
    'wheel',
    (e) => {
      const dy = e.deltaY;
      if (Math.abs(dy) < 0.5) return;
      e.preventDefault();
      const factor = dy > 0 ? 0.92 : 1.08;
      worldPreview2dZoom = Math.min(6, Math.max(0.2, worldPreview2dZoom * factor));
      applyWorldPreview2dZoom();
    },
    { passive: false }
  );
}

/**
 * Notifies the map iframe that world preview data is ready
 * Called when the backend emits the map-preview-ready event
 */
async function showWorldPreviewButton() {
  // Retry briefly: PNG may not be visible to the next read the same millisecond it was written.
  for (let attempt = 0; attempt < 15; attempt++) {
    await loadWorldMapData();
    if (currentWorldMapData) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  // Never await mesh I/O here — preload cache only (3D can arrive seconds later).
  void loadWorldMeshData().catch((e) => console.warn("3D mesh preload skipped:", e));
  if (worldPath && worldPath.trim()) {
    const wp = worldPath;
    window.setTimeout(() => {
      void loadWorldMeshData().catch(() => {});
    }, 1200);
    window.setTimeout(() => {
      void loadWorldMeshData().catch(() => {});
    }, 4000);
  }

  if (currentWorldMapData) {
    const mapFrame = document.querySelector('.map-container');
    if (mapFrame && mapFrame.contentWindow) {
      mapFrame.contentWindow.postMessage({
        type: 'worldPreviewReady',
        data: currentWorldMapData
      }, '*');
      console.log("World preview data sent to map iframe");
    }
    openWorldPreviewModal(currentWorldMapData.image_base64);
  } else {
    console.warn("Map data not available yet");
  }
}

/**
 * Shows the preview dialog (2D + optional 3D mesh).
 * @param {string} imageDataUrl
 */
function openWorldPreviewModal(imageDataUrl) {
  const modal = document.getElementById('world-preview-modal');
  const img = document.getElementById('world-preview-modal-img');
  if (!modal || !img) return;
  img.src = imageDataUrl || '';
  const title =
    (window.localization && window.localization.world_preview_title) || 'World preview';
  img.alt = title;
  modal.style.display = 'flex';
  modal.style.justifyContent = 'center';
  modal.style.alignItems = 'center';
  resetWorldPreview2dZoom();
  switchToWorldPreviewTab('2d');
}

function closeWorldPreviewModal() {
  import('./preview3d.js')
    .then((m) => m.disposePreview3d())
    .catch(() => {});

  const modal = document.getElementById('world-preview-modal');
  const img = document.getElementById('world-preview-modal-img');
  if (modal) modal.style.display = 'none';
  if (img) img.src = '';
}

/**
 * @param {'2d' | '3d'} which
 */
async function switchToWorldPreviewTab(which) {
  const pane2 = document.getElementById('world-preview-pane-2d');
  const pane3 = document.getElementById('world-preview-pane-3d');
  const tab2 = document.getElementById('world-preview-tab-2d');
  const tab3 = document.getElementById('world-preview-tab-3d');
  const status = document.getElementById('world-preview-3d-status');
  const canvas = document.getElementById('world-preview-3d-canvas');
  const progressWrap = document.getElementById('world-preview-3d-progress-wrap');
  const progressFill = document.getElementById('world-preview-3d-progress-fill');

  if (!pane2 || !pane3 || !tab2 || !tab3) return;

  if (which === '2d') {
    import('./preview3d.js')
      .then((m) => m.disposePreview3d())
      .catch(() => {});
    pane2.style.display = '';
    pane3.style.display = 'none';
    tab2.classList.add('world-preview-tab-active');
    tab3.classList.remove('world-preview-tab-active');
    tab2.setAttribute('aria-selected', 'true');
    tab3.setAttribute('aria-selected', 'false');
    return;
  }

  pane2.style.display = 'none';
  pane3.style.display = '';
  tab3.classList.add('world-preview-tab-active');
  tab2.classList.remove('world-preview-tab-active');
  tab3.setAttribute('aria-selected', 'true');
  tab2.setAttribute('aria-selected', 'false');

  if (!status || !canvas) return;

  const set3dProgress = (pct, text, color = '#ececec') => {
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressFill) progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    status.style.display = 'block';
    status.style.color = color;
    status.textContent = text;
  };
  const hide3dProgress = () => {
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
  };

  set3dProgress(
    8,
    (window.localization && window.localization.world_preview_3d_building) ||
      'Loading 3D view…'
  );

  // Keep the status visible until the first frame is actually rendered.
  let done = false;
  const onFirstFrame = () => {
    if (done) return;
    done = true;
    hide3dProgress();
    status.style.display = 'none';
    status.textContent = '';
    window.removeEventListener('arnis-preview3d-first-frame', onFirstFrame);
  };
  window.addEventListener('arnis-preview3d-first-frame', onFirstFrame);

  try {
    if (!currentWorldMapData && worldPath) {
      set3dProgress(15, 'Loading map preview…');
      await loadWorldMapData();
    }
    if (!currentWorldMapData) {
      set3dProgress(
        100,
        (window.localization && window.localization.world_preview_3d_no_map) ||
          'Map image not loaded. Close and reopen preview after generation finishes.',
        '#fa7878'
      );
      return;
    }

    const mod = await import('./preview3d.js');
    const mcW = Math.max(
      1,
      (currentWorldMapData.max_mc_x || 0) - (currentWorldMapData.min_mc_x || 0) + 1
    );
    const mcH = Math.max(
      1,
      (currentWorldMapData.max_mc_z || 0) - (currentWorldMapData.min_mc_z || 0) + 1
    );
    const worldArea = mcW * mcH;
    // Big maps are auto-switched to map-based 3D for stability/speed.
    const useMapPlaneForLargeArea = worldArea > 1_800_000;

    if (useMapPlaneForLargeArea) {
      set3dProgress(45, 'Large area detected, using fast 3D preview…');
      await mod.runPreview3dMapPlane(canvas, currentWorldMapData);
      window.setTimeout(onFirstFrame, 900);
      return;
    }

    let meshB64 = worldPreviewMeshGzipB64;
    const meshWorldPath = importPreviewWorldPath || worldPath;
    if (!meshB64 && meshWorldPath) {
      set3dProgress(28, 'Checking cached 3D mesh…');
      try {
        meshB64 = await invoke('gui_get_world_preview_mesh_gzip_base64', {
          worldPath: meshWorldPath
        });
        if (meshB64) {
          worldPreviewMeshGzipB64 = meshB64;
        }
      } catch (e) {
        console.warn('3D mesh cache read:', e);
      }
    }

    if (!meshB64 && meshWorldPath) {
      set3dProgress(
        55,
        (window.localization && window.localization.world_preview_3d_building) ||
          'Building 3D block preview…'
      );
      await buildWorldPreviewMeshData(meshWorldPath);
      meshB64 = worldPreviewMeshGzipB64;
    }

    const unavailableMsg =
      (window.localization && window.localization.world_preview_3d_unavailable) ||
      '3D preview could not be loaded for this world.';
    const meshTooLargeMsg =
      (window.localization && window.localization.world_preview_3d_mesh_too_large) ||
      '3D model too large for the browser. Try a smaller area.';

    if (meshB64) {
      try {
        set3dProgress(82, 'Decoding 3D mesh…');
        await mod.runPreview3d(canvas, meshB64);
        // If for any reason the first-frame event didn’t fire, hide the status after a bit.
        window.setTimeout(onFirstFrame, 1500);
      } catch (voxelErr) {
        console.warn('Voxel 3D failed:', voxelErr);
        const isTooLarge =
          voxelErr &&
          (voxelErr.message === 'MESH_TOO_LARGE' ||
            String(voxelErr) === 'Error: MESH_TOO_LARGE');
        if (isTooLarge) {
          set3dProgress(60, '3D mesh too large, switching to fast preview…', '#d4a574');
          await mod.runPreview3dMapPlane(canvas, currentWorldMapData);
          window.setTimeout(onFirstFrame, 900);
        } else {
          set3dProgress(100, unavailableMsg, '#fa7878');
        }
      }
    } else {
      set3dProgress(60, 'No 3D mesh cache. Using fast preview…', '#d4a574');
      await mod.runPreview3dMapPlane(canvas, currentWorldMapData);
      window.setTimeout(onFirstFrame, 900);
    }
  } catch (e) {
    console.error(e);
    window.removeEventListener('arnis-preview3d-first-frame', onFirstFrame);
    set3dProgress(
      100,
      (window.localization && window.localization.world_preview_3d_error) ||
        String(e),
      '#fa7878'
    );
  }
}

function initWorldPreviewModal() {
  const modal = document.getElementById('world-preview-modal');
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeWorldPreviewModal();
    }
  });

  const tab2 = document.getElementById('world-preview-tab-2d');
  const tab3 = document.getElementById('world-preview-tab-3d');
  if (tab2) {
    tab2.addEventListener('click', () => switchToWorldPreviewTab('2d'));
  }
  if (tab3) {
    tab3.addEventListener('click', () => {
      void switchToWorldPreviewTab('3d').catch((err) => console.error('3D preview tab:', err));
    });
  }

  initWorldPreview2dZoom();
  initHomepageImport();
}

function initHomepageImport() {
  if (initHomepageImport._inited) return;
  initHomepageImport._inited = true;

  const btn = document.getElementById('import-world-btn');
  const input = document.getElementById('import-world-file');
  const status = document.getElementById('import-world-status');
  if (!btn || !input) return;

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      await importZipAndPreview(f, status || null);
      const selectedWorld = document.getElementById('selected-world');
      if (selectedWorld) {
        selectedWorld.textContent = f.name;
        selectedWorld.style.color = '#8de38d';
      }
    } catch (e) {
      if (status) {
        status.style.color = '#fa7878';
        status.textContent = `Import failed: ${String(e)}`;
      }
    }
  });
}

/**
 * Notifies the map iframe that the world has changed (reset preview)
 */
function notifyWorldChanged() {
  currentWorldMapData = null;
  worldPreviewMeshGzipB64 = null;
  importPreviewWorldPath = null;
  updatePreviewButtonEnabled();
  const mapFrame = document.querySelector('.map-container');
  if (mapFrame && mapFrame.contentWindow) {
    mapFrame.contentWindow.postMessage({
      type: 'worldChanged'
    }, '*');
  }
}

function updatePreviewButtonEnabled() {
  const btn = document.getElementById('preview-button');
  if (!btn) return;

  const enabled = selectedWorldFormat === 'java' && Boolean(worldPath && worldPath.trim());
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? '1' : '0.6';
  btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
}

async function openWorldPreview() {
  if (selectedWorldFormat !== 'java' || !worldPath) return;

  // If a preview already exists on disk, load it and open immediately.
  await loadWorldMapData();
  if (!currentWorldMapData) {
    // If there is no map image yet, the user truly needs to generate once.
    const selectedWorldText = document.getElementById('selected-world');
    if (selectedWorldText) {
      const msg =
        (window.localization && window.localization.world_preview_3d_no_map) ||
        'Map image not loaded. Close and reopen preview after generation finishes.';
      selectedWorldText.textContent = msg;
      selectedWorldText.style.color = '#fa7878';
    }
    return;
  }

  // Preload mesh cache if it exists; do not block UI.
  void loadWorldMeshData().catch(() => {});
  openWorldPreviewModal(currentWorldMapData.image_base64);
}

/**
 * Loads the world map data from the backend
 */
async function loadWorldMapData() {
  if (!worldPath) return;

  try {
    const mapData = await invoke('gui_get_world_map_data', { worldPath: worldPath });
    if (mapData) {
      currentWorldMapData = mapData;
      console.log("World map data loaded successfully");
    }
  } catch (error) {
    console.error("Failed to load world map data:", error);
  }
}

/** Reads cached `arnis_preview_mesh.bin.gz` only (fast). */
async function loadWorldMeshData() {
  if (!worldPath) return;

  const meshB64 = await invoke('gui_get_world_preview_mesh_gzip_base64', {
    worldPath: worldPath
  });
  if (meshB64) {
    worldPreviewMeshGzipB64 = meshB64;
    console.log("World 3D mesh cache loaded");
  }
}

/** Full mesh build from disk (slow) — use on 3D tab only. */
async function buildWorldPreviewMeshData(forWorldPath) {
  const targetPath = forWorldPath || worldPath;
  if (!targetPath) return;

  try {
    const meshB64 = await invoke('gui_build_world_preview_mesh_gzip_base64', {
      worldPath: targetPath
    });
    if (meshB64) {
      worldPreviewMeshGzipB64 = meshB64;
      console.log("World 3D mesh built");
    }
  } catch (e) {
    console.warn("3D mesh build failed:", e);
  }
}
