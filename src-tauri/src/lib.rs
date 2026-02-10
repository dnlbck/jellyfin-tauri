use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_store::StoreExt;

// JS injection scripts - run at document_start on every page load
const INJECTION_SCRIPT: &str = include_str!("../native/injection.js");
const MPV_VIDEO_PLAYER: &str = include_str!("../native/mpvVideoPlayer.js");
const MPV_AUDIO_PLAYER: &str = include_str!("../native/mpvAudioPlayer.js");
const INPUT_PLUGIN: &str = include_str!("../native/inputPlugin.js");

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
async fn settings_set_values(
    app: AppHandle,
    values: serde_json::Map<String, Value>,
) -> Result<(), String> {
    debug!("settings_set_values: {} sections", values.len());
    let store = app.store("settings.json").map_err(|e| e.to_string())?;

    let mut changed: Vec<(String, String, Value)> = Vec::new();
    for (section, section_vals) in &values {
        if let Some(obj) = section_vals.as_object() {
            for (key, val) in obj {
                let store_key = format!("settings.{}.{}", section, key);
                store.set(&store_key, val.clone());
                changed.push((section.clone(), key.clone(), val.clone()));
            }
        }
    }

    // Emit change events for each value
    for (section, key, value) in changed {
        app.emit(
            "settings-value-changed",
            serde_json::json!({
                "section": section,
                "key": key,
                "value": value,
            }),
        )
        .ok();
    }

    Ok(())
}

#[tauri::command]
async fn settings_delete_section(app: AppHandle, section: String) -> Result<(), String> {
    debug!("settings_delete_section: {}", section);
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let prefix = format!("settings.{}.", section);

    let keys_to_delete: Vec<String> = store
        .entries()
        .into_iter()
        .filter_map(|(k, _): (String, _)| {
            if k.starts_with(&prefix) {
                Some(k.clone())
            } else {
                None
            }
        })
        .collect();

    for key in keys_to_delete {
        store.delete(&key);
    }

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

#[tauri::command]
async fn window_set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    info!("Setting always-on-top: {}", enabled);
    let win = app.get_webview_window("main").ok_or("Main window not found")?;
    win.set_always_on_top(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_is_always_on_top(app: AppHandle) -> Result<bool, String> {
    let win = app.get_webview_window("main").ok_or("Main window not found")?;
    win.is_always_on_top().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_raise(app: AppHandle) -> Result<(), String> {
    debug!("Raising main window");
    let win = app.get_webview_window("main").ok_or("Main window not found")?;
    win.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_set_cursor_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("Main window not found")?;
    win.set_cursor_visible(visible).map_err(|e| e.to_string())
}

#[tauri::command]
async fn window_save_geometry(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("Main window not found")?;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;

    // Don't save geometry while fullscreen — we want the windowed geometry
    if win.is_fullscreen().unwrap_or(false) {
        debug!("Skipping geometry save while fullscreen");
        return Ok(());
    }

    let maximized = win.is_maximized().unwrap_or(false);
    if maximized {
        // Only save the maximized flag, keep prior windowed position/size
        store.set("state.geometry.maximized", serde_json::json!(true));
        debug!("Saved geometry: maximized=true");
    } else {
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let size = win.outer_size().map_err(|e| e.to_string())?;
        store.set("state.geometry.x", serde_json::json!(pos.x));
        store.set("state.geometry.y", serde_json::json!(pos.y));
        store.set("state.geometry.w", serde_json::json!(size.width));
        store.set("state.geometry.h", serde_json::json!(size.height));
        store.set("state.geometry.maximized", serde_json::json!(false));
        debug!("Saved geometry: {}x{} at ({}, {})", size.width, size.height, pos.x, pos.y);
    }

    Ok(())
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
fn system_restart(app: AppHandle) {
    info!("Application restart requested");
    app.restart();
}

#[tauri::command]
fn system_debug_info(app: AppHandle) -> Result<String, String> {
    let version = app.package_info().version.to_string();
    let info = format!(
        "App: Jellyfin Desktop (Tauri)\n\
         Version: {}\n\
         OS: {} {}\n\
         Arch: {}\n\
         WebView: WebView2 (Tauri)\n",
        version,
        std::env::consts::OS,
        std::env::consts::FAMILY,
        std::env::consts::ARCH,
    );
    Ok(info)
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
// OS Media Controls (SMTC / MPRIS)
// ========================================================================

struct MediaControlsState {
    controls: Mutex<Option<souvlaki::MediaControls>>,
    is_playing: AtomicBool,
}

#[tauri::command]
fn media_notify_playback_state(
    state: State<'_, MediaControlsState>,
    playing: bool,
) {
    state.is_playing.store(playing, Ordering::Relaxed);
    if let Ok(mut guard) = state.controls.lock() {
        if let Some(controls) = guard.as_mut() {
            let playback = if playing {
                souvlaki::MediaPlayback::Playing { progress: None }
            } else {
                souvlaki::MediaPlayback::Paused { progress: None }
            };
            controls.set_playback(playback).ok();
        }
    }
}

#[tauri::command]
fn media_notify_metadata(
    state: State<'_, MediaControlsState>,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    cover_url: Option<String>,
    duration_ms: Option<u64>,
) {
    debug!(
        "media_notify_metadata: title={}, artist={:?}, album={:?}",
        title, artist, album
    );
    if let Ok(mut guard) = state.controls.lock() {
        if let Some(controls) = guard.as_mut() {
            controls
                .set_metadata(souvlaki::MediaMetadata {
                    title: Some(&title),
                    artist: artist.as_deref(),
                    album: album.as_deref(),
                    cover_url: cover_url.as_deref(),
                    duration: duration_ms.map(|ms| std::time::Duration::from_millis(ms)),
                })
                .ok();
        }
    }
}

#[tauri::command]
fn media_notify_stop(state: State<'_, MediaControlsState>) {
    state.is_playing.store(false, Ordering::Relaxed);
    if let Ok(mut guard) = state.controls.lock() {
        if let Some(controls) = guard.as_mut() {
            controls
                .set_playback(souvlaki::MediaPlayback::Stopped)
                .ok();
        }
    }
}

#[tauri::command]
fn media_notify_position(
    state: State<'_, MediaControlsState>,
    position_ms: u64,
) {
    if let Ok(mut guard) = state.controls.lock() {
        if let Some(controls) = guard.as_mut() {
            let progress = Some(souvlaki::MediaPosition(
                std::time::Duration::from_millis(position_ms),
            ));
            let playing = state.is_playing.load(Ordering::Relaxed);
            let playback = if playing {
                souvlaki::MediaPlayback::Playing { progress }
            } else {
                souvlaki::MediaPlayback::Paused { progress }
            };
            controls.set_playback(playback).ok();
        }
    }
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
            let win = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .initialization_script(INJECTION_SCRIPT)
                .initialization_script(MPV_VIDEO_PLAYER)
                .initialization_script(MPV_AUDIO_PLAYER)
                .initialization_script(INPUT_PLUGIN)
                .build()?;
            info!("Main window created successfully");

            // ── Initialize OS media controls (SMTC on Windows, MPRIS on Linux) ──
            {
                #[cfg(target_os = "windows")]
                let hwnd = {
                    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                    match win.window_handle() {
                        Ok(handle) => match handle.as_raw() {
                            RawWindowHandle::Win32(h) => {
                                Some(h.hwnd.get() as *mut std::ffi::c_void)
                            }
                            _ => None,
                        },
                        Err(e) => {
                            warn!("Failed to get window handle for SMTC: {}", e);
                            None
                        }
                    }
                };

                #[cfg(not(target_os = "windows"))]
                let hwnd = None;

                let config = souvlaki::PlatformConfig {
                    dbus_name: "jellyfin_desktop",
                    display_name: "Jellyfin Desktop",
                    hwnd,
                };

                match souvlaki::MediaControls::new(config) {
                    Ok(mut controls) => {
                        let app_handle = app.handle().clone();
                        if let Err(e) = controls.attach(move |event: souvlaki::MediaControlEvent| {
                            use souvlaki::{MediaControlEvent, SeekDirection};
                            let action = match event {
                                MediaControlEvent::Play => "play",
                                MediaControlEvent::Pause => "pause",
                                MediaControlEvent::Toggle => "play_pause",
                                MediaControlEvent::Next => "next",
                                MediaControlEvent::Previous => "previous",
                                MediaControlEvent::Stop => "stop",
                                MediaControlEvent::Seek(SeekDirection::Forward) => "seek_forward",
                                MediaControlEvent::Seek(SeekDirection::Backward) => "seek_backward",
                                MediaControlEvent::Raise => {
                                    if let Some(w) = app_handle.get_webview_window("main") {
                                        let _ = w.unminimize();
                                        let _ = w.set_focus();
                                    }
                                    return;
                                }
                                MediaControlEvent::Quit => {
                                    app_handle.exit(0);
                                    return;
                                }
                                _ => return,
                            };
                            let _ = app_handle.emit("media-control-event", action);
                        }) {
                            warn!("Failed to attach media controls handler: {:?}", e);
                        }
                        app.manage(MediaControlsState {
                            controls: Mutex::new(Some(controls)),
                            is_playing: AtomicBool::new(false),
                        });
                        info!("OS media controls initialized (SMTC/MPRIS)");
                    }
                    Err(e) => {
                        warn!("Failed to initialize OS media controls: {:?}", e);
                        app.manage(MediaControlsState {
                            controls: Mutex::new(None),
                            is_playing: AtomicBool::new(false),
                        });
                    }
                }
            }

            // ── Restore saved window geometry ──
            let store = app.store("settings.json").ok();
            if let Some(ref store) = store {
                let x = store.get("state.geometry.x").and_then(|v| v.as_i64()).map(|v| v as i32);
                let y = store.get("state.geometry.y").and_then(|v| v.as_i64()).map(|v| v as i32);
                let w = store.get("state.geometry.w").and_then(|v| v.as_u64()).map(|v| v as u32);
                let h = store.get("state.geometry.h").and_then(|v| v.as_u64()).map(|v| v as u32);
                let maximized = store.get("state.geometry.maximized").and_then(|v| v.as_bool()).unwrap_or(false);

                if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                    // Sanity check: only restore if size is reasonable
                    if w >= 200 && h >= 150 {
                        info!("Restoring window geometry: {}x{} at ({}, {}), maximized={}", w, h, x, y, maximized);
                        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                        let _ = win.set_size(tauri::PhysicalSize::new(w, h));
                    }
                }
                if maximized {
                    info!("Restoring maximized state");
                    let _ = win.maximize();
                }
            }

            // ── Debounced geometry save on move/resize ──
            let debounce_timer: std::sync::Arc<Mutex<Option<std::time::Instant>>> =
                std::sync::Arc::new(Mutex::new(None));

            // Save geometry on move
            let app_handle = app.handle().clone();
            let timer_clone = debounce_timer.clone();
            win.on_window_event(move |event| {
                let should_save = match event {
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => true,
                    _ => false,
                };
                if should_save {
                    let mut timer = timer_clone.lock().unwrap();
                    *timer = Some(std::time::Instant::now());
                    let app_h = app_handle.clone();
                    let timer_ref = timer_clone.clone();
                    // Spawn a debounce task — only the latest one actually saves
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let should_run = {
                            let timer = timer_ref.lock().unwrap();
                            timer
                                .map(|t| t.elapsed() >= std::time::Duration::from_millis(900))
                                .unwrap_or(false)
                        };
                        if should_run {
                            let _ = window_save_geometry(app_h).await;
                        }
                    });
                }
            });

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
            settings_set_values,
            settings_delete_section,
            settings_get_all,
            // Window
            window_set_fullscreen,
            window_is_fullscreen,
            window_set_always_on_top,
            window_is_always_on_top,
            window_raise,
            window_set_cursor_visible,
            window_save_geometry,
            // System
            system_hello,
            system_open_external_url,
            system_exit,
            system_restart,
            system_debug_info,
            system_check_for_updates,
            // Power
            power_set_screensaver_enabled,
            // Media Controls
            media_notify_playback_state,
            media_notify_metadata,
            media_notify_stop,
            media_notify_position,
            // Logging
            log_from_webview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
