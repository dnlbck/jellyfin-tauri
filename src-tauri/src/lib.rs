use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_store::StoreExt;

// JS injection scripts - run at document_start on every page load
const INJECTION_SCRIPT: &str = include_str!("../native/injection.js");
const MPV_VIDEO_PLAYER: &str = include_str!("../native/mpvVideoPlayer.js");
const MPV_AUDIO_PLAYER: &str = include_str!("../native/mpvAudioPlayer.js");

// ========================================================================
// Types
// ========================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct ServerInfo {
    #[serde(rename = "ServerName")]
    name: String,
    #[serde(rename = "Version")]
    version: String,
    #[serde(rename = "Id")]
    id: String,
}

// ========================================================================
// Server Commands
// ========================================================================

#[tauri::command]
async fn check_server_connectivity(url: String) -> Result<ServerInfo, String> {
    info!("Checking server connectivity: {}", url);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| {
            error!("Failed to build HTTP client: {}", e);
            e.to_string()
        })?;

    let info_url = format!("{}/System/Info/Public", url.trim_end_matches('/'));
    debug!("Fetching server info from: {}", info_url);
    let resp = client
        .get(&info_url)
        .send()
        .await
        .map_err(|e| {
            error!("Connection to {} failed: {}", info_url, e);
            format!("Connection failed: {}", e)
        })?;

    let status = resp.status();
    debug!("Server response status: {}", status);
    if !status.is_success() {
        error!("Server returned non-success status: {}", status);
        return Err(format!("Server returned status {}", status));
    }

    let server_info = resp.json::<ServerInfo>()
        .await
        .map_err(|e| {
            error!("Failed to parse server response: {}", e);
            format!("Invalid server response: {}", e)
        })?;
    info!("Connected to server: {} v{} (id={})", server_info.name, server_info.version, server_info.id);
    Ok(server_info)
}

#[tauri::command]
async fn save_server_url(app: AppHandle, url: String) -> Result<(), String> {
    info!("Saving server URL: {}", url);
    let store = app.store("settings.json").map_err(|e| {
        error!("Failed to open settings store: {}", e);
        e.to_string()
    })?;
    store.set("server_url", serde_json::json!(url));
    debug!("Server URL saved successfully");
    Ok(())
}

#[tauri::command]
async fn get_saved_server(app: AppHandle) -> Result<Option<String>, String> {
    debug!("Loading saved server URL");
    let store = app.store("settings.json").map_err(|e| {
        error!("Failed to open settings store: {}", e);
        e.to_string()
    })?;
    let result = match store.get("server_url") {
        Some(val) => {
            let url = val.as_str().map(String::from);
            info!("Loaded saved server: {:?}", url);
            Ok(url)
        }
        None => {
            info!("No saved server URL found");
            Ok(None)
        }
    };
    result
}

#[tauri::command]
async fn navigate_to_server(app: AppHandle, url: String) -> Result<(), String> {
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| {
            error!("navigate_to_server: main window not found");
            "Main window not found".to_string()
        })?;

    let nav_url = format!("{}/web/index.html", url.trim_end_matches('/'));
    info!("Navigating webview to: {}", nav_url);
    webview
        .eval(&format!("window.location.href = '{}';", nav_url))
        .map_err(|e| {
            error!("Failed to navigate webview: {}", e);
            e.to_string()
        })
}

// ========================================================================
// Settings Commands
// ========================================================================

#[tauri::command]
async fn settings_get_value(app: AppHandle, section: String, key: String) -> Result<Value, String> {
    debug!("settings_get_value: {}.{}", section, key);
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let store_key = format!("settings.{}.{}", section, key);
    let val = store.get(&store_key).unwrap_or(Value::Null);
    debug!("settings_get_value: {}.{} = {:?}", section, key, val);
    Ok(val)
}

#[tauri::command]
async fn settings_set_value(
    app: AppHandle,
    section: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let store_key = format!("settings.{}.{}", section, key);
    store.set(&store_key, value.clone());

    app.emit(
        "settings-value-changed",
        serde_json::json!({
            "section": section,
            "key": key,
            "value": value,
        }),
    )
    .ok();

    Ok(())
}

#[tauri::command]
async fn settings_get_all(app: AppHandle, section: String) -> Result<Value, String> {
    debug!("settings_get_all: section={}", section);
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let prefix = format!("settings.{}.", section);

    let mut result = serde_json::Map::new();
    for (key, value) in store.entries() {
        if let Some(setting_key) = key.strip_prefix(&prefix) {
            result.insert(setting_key.to_string(), value.clone());
        }
    }

    debug!("settings_get_all: {} returned {} keys", section, result.len());
    Ok(Value::Object(result))
}

// ========================================================================
// Window Commands
// ========================================================================

#[tauri::command]
async fn window_set_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_is_fullscreen(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window.is_fullscreen().map_err(|e| e.to_string())
}

// ========================================================================
// System Commands
// ========================================================================

#[tauri::command]
async fn system_hello(name: String) {
    info!("Hello from: {}", name);
}

#[tauri::command]
async fn system_open_external_url(url: String) -> Result<(), String> {
    info!("Opening external URL: {}", url);
    open::that(&url).map_err(|e| {
        error!("Failed to open external URL: {}", e);
        e.to_string()
    })
}

#[tauri::command]
async fn system_exit(app: AppHandle) {
    info!("Application exit requested");
    app.exit(0);
}

#[tauri::command]
async fn system_check_for_updates(app: AppHandle) -> Result<(), String> {
    info!("Checking for updates");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = "https://github.com/jellyfin/jellyfin-desktop/releases/latest";
    match client.get(url).send().await {
        Ok(resp) => {
            let final_url = resp.url().to_string();
            info!("Update check result: {}", final_url);
            app.emit("system-update-info", final_url).ok();
        }
        Err(e) => {
            warn!("Update check failed (non-critical): {}", e);
        }
    }

    Ok(())
}

// ========================================================================
// Power Commands
// ========================================================================

#[cfg(target_os = "windows")]
mod power {
    extern "system" {
        fn SetThreadExecutionState(esFlags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x80000000;
    const ES_DISPLAY_REQUIRED: u32 = 0x00000002;
    const ES_SYSTEM_REQUIRED: u32 = 0x00000001;

    pub fn set_screensaver_enabled(enabled: bool) {
        unsafe {
            if enabled {
                SetThreadExecutionState(ES_CONTINUOUS);
            } else {
                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
            }
        }
    }
}

#[tauri::command]
async fn power_set_screensaver_enabled(enabled: bool) -> Result<(), String> {
    debug!("Setting screensaver enabled: {}", enabled);
    #[cfg(target_os = "windows")]
    power::set_screensaver_enabled(enabled);
    Ok(())
}

// ========================================================================
// Webview Log Forwarding
// ========================================================================

#[tauri::command]
async fn log_from_webview(level: String, message: String, context: Option<String>) {
    let ctx = context.as_deref().unwrap_or("webview");
    match level.as_str() {
        "error" => error!("[{}] {}", ctx, message),
        "warn"  => warn!("[{}] {}", ctx, message),
        "info"  => info!("[{}] {}", ctx, message),
        "debug" => debug!("[{}] {}", ctx, message),
        _       => debug!("[{}] {}", ctx, message),
    }
}



// ========================================================================
// Entry Point
// ========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("jellyfin-desktop".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .max_file_size(5_000_000) // 5 MB per log file
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .level(log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            info!("Jellyfin Desktop starting up");

            // Log the app data directory for easy log file discovery
            if let Ok(log_dir) = app.path().app_log_dir() {
                info!("Log directory: {}", log_dir.display());
            }
            if let Ok(data_dir) = app.path().app_data_dir() {
                info!("Data directory: {}", data_dir.display());
            }

            // Create main window from config, adding our initialization script
            // The window has "create": false in tauri.conf.json so Tauri doesn't auto-create it
            info!("Creating main webview window with injection scripts");
            let config = app.config().app.windows[0].clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .initialization_script(INJECTION_SCRIPT)
                .initialization_script(MPV_VIDEO_PLAYER)
                .initialization_script(MPV_AUDIO_PLAYER)
                .build()?;
            info!("Main window created successfully");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Server
            check_server_connectivity,
            save_server_url,
            get_saved_server,
            navigate_to_server,
            // Settings
            settings_get_value,
            settings_set_value,
            settings_get_all,
            // Window
            window_set_fullscreen,
            window_is_fullscreen,
            // System
            system_hello,
            system_open_external_url,
            system_exit,
            system_check_for_updates,
            // Power
            power_set_screensaver_enabled,
            // Logging
            log_from_webview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
