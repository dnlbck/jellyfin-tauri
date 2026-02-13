use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

// Shared cancellation flag for server connectivity checks
struct ConnectivityCancelFlag(Arc<AtomicBool>);

// ========================================================================
// Server Commands
// ========================================================================

#[tauri::command]
async fn check_server_connectivity(
    url: String,
    cancel_flag: State<'_, ConnectivityCancelFlag>,
) -> Result<ServerInfo, String> {
    info!("Checking server connectivity: {}", url);
    // Reset flag at start of new check
    cancel_flag.0.store(false, Ordering::Relaxed);

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| {
            error!("Failed to build HTTP client: {}", e);
            e.to_string()
        })?;

    if cancel_flag.0.load(Ordering::Relaxed) {
        return Err("Cancelled".to_string());
    }

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

    if cancel_flag.0.load(Ordering::Relaxed) {
        return Err("Cancelled".to_string());
    }

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
fn cancel_server_connectivity(cancel_flag: State<'_, ConnectivityCancelFlag>) {
    debug!("Server connectivity check cancelled");
    cancel_flag.0.store(true, Ordering::Relaxed);
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
    let parsed: tauri::Url = nav_url.parse().map_err(|e| {
        error!("Failed to parse navigation URL: {}", e);
        format!("Invalid URL: {}", e)
    })?;
    webview
        .navigate(parsed)
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
async fn window_set_title(app: AppHandle, title: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window.set_title(&title).map_err(|e| e.to_string())
}

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

    let url = "https://github.com/dnlbck/jellyfin-tauri/releases/latest";
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

#[tauri::command]
fn system_network_addresses() -> Vec<String> {
    let mut addresses = Vec::new();
    if let Ok(list) = local_ip_address::list_afinet_netifas() {
        for (_, ip) in list {
            let s = ip.to_string();
            if !addresses.contains(&s) {
                addresses.push(s);
            }
        }
    }
    debug!("Network addresses: {:?}", addresses);
    addresses
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

#[cfg(target_os = "linux")]
mod power {
    use std::sync::Mutex;

    static INHIBIT_COOKIE: Mutex<Option<u32>> = Mutex::new(None);

    pub fn set_screensaver_enabled(enabled: bool) {
        // Use org.freedesktop.ScreenSaver D-Bus interface
        tokio::task::block_in_place(|| {
            let rt = tokio::runtime::Handle::current();
            rt.block_on(async {
                match zbus::Connection::session().await {
                    Ok(conn) => {
                        if enabled {
                            // Un-inhibit: release the cookie
                            let cookie = INHIBIT_COOKIE.lock().unwrap().take();
                            if let Some(c) = cookie {
                                let _ = conn
                                    .call_method(
                                        Some("org.freedesktop.ScreenSaver"),
                                        "/org/freedesktop/ScreenSaver",
                                        Some("org.freedesktop.ScreenSaver"),
                                        "UnInhibit",
                                        &(c,),
                                    )
                                    .await;
                                log::debug!("Screensaver un-inhibited (cookie={})", c);
                            }
                        } else {
                            // Inhibit
                            match conn
                                .call_method(
                                    Some("org.freedesktop.ScreenSaver"),
                                    "/org/freedesktop/ScreenSaver",
                                    Some("org.freedesktop.ScreenSaver"),
                                    "Inhibit",
                                    &("Jellyfin Desktop", "Media playback"),
                                )
                                .await
                            {
                                Ok(reply) => {
                                    if let Ok(cookie) = reply.body().deserialize::<u32>() {
                                        *INHIBIT_COOKIE.lock().unwrap() = Some(cookie);
                                        log::debug!("Screensaver inhibited (cookie={})", cookie);
                                    }
                                }
                                Err(e) => {
                                    log::warn!("Failed to inhibit screensaver via D-Bus: {}", e);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to connect to session D-Bus: {}", e);
                    }
                }
            });
        });
    }
}

#[tauri::command]
async fn power_set_screensaver_enabled(enabled: bool) -> Result<(), String> {
    debug!("Setting screensaver enabled: {}", enabled);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    power::set_screensaver_enabled(enabled);
    Ok(())
}

// ========================================================================
// Windows Taskbar Integration (Progress Bar)
// ========================================================================

#[cfg(target_os = "windows")]
mod taskbar {
    use std::sync::Mutex;

    // ITaskbarList3 COM interface for progress bar
    #[repr(C)]
    struct ITaskbarList3Vtbl {
        // IUnknown
        query_interface: usize,
        add_ref: unsafe extern "system" fn(*mut ITaskbarList3) -> u32,
        release: unsafe extern "system" fn(*mut ITaskbarList3) -> u32,
        // ITaskbarList
        hr_init: unsafe extern "system" fn(*mut ITaskbarList3) -> i32,
        add_tab: usize,
        delete_tab: usize,
        activate_tab: usize,
        set_active_alt: usize,
        // ITaskbarList2
        mark_fullscreen_window: usize,
        // ITaskbarList3
        set_progress_value:
            unsafe extern "system" fn(*mut ITaskbarList3, isize, u64, u64) -> i32,
        set_progress_state:
            unsafe extern "system" fn(*mut ITaskbarList3, isize, u32) -> i32,
        // ... more methods we don't need
    }

    #[repr(C)]
    struct ITaskbarList3 {
        vtbl: *const ITaskbarList3Vtbl,
    }

    // Progress state flags
    const TBPF_NOPROGRESS: u32 = 0x00;
    const TBPF_NORMAL: u32 = 0x02;
    const TBPF_PAUSED: u32 = 0x08;

    extern "system" {
        fn CoCreateInstance(
            rclsid: *const [u8; 16],
            punk_outer: *mut std::ffi::c_void,
            cls_context: u32,
            riid: *const [u8; 16],
            ppv: *mut *mut std::ffi::c_void,
        ) -> i32;
        fn CoInitializeEx(reserved: *mut std::ffi::c_void, co_init: u32) -> i32;
    }

    // CLSID_TaskbarList = {56FDF344-FD6D-11d0-958A-006097C9A090}
    const CLSID_TASKBAR_LIST: [u8; 16] = [
        0x44, 0xF3, 0xFD, 0x56, 0x6D, 0xFD, 0xD0, 0x11,
        0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90,
    ];
    // IID_ITaskbarList3 = {ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf}
    const IID_ITASKBAR_LIST3: [u8; 16] = [
        0x91, 0xFB, 0x1A, 0xEA, 0x28, 0x9E, 0x86, 0x4B,
        0x90, 0xE9, 0x9E, 0x9F, 0x8A, 0x5E, 0xEF, 0xAF,
    ];

    pub struct TaskbarProgress {
        taskbar: *mut ITaskbarList3,
        hwnd: isize,
    }

    // Safety: COM pointers are thread-safe for ITaskbarList3 when CoInitialized per-thread
    unsafe impl Send for TaskbarProgress {}
    unsafe impl Sync for TaskbarProgress {}

    impl TaskbarProgress {
        pub fn new(hwnd: isize) -> Option<Self> {
            unsafe {
                CoInitializeEx(std::ptr::null_mut(), 0x2); // COINIT_APARTMENTTHREADED
                let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
                let hr = CoCreateInstance(
                    &CLSID_TASKBAR_LIST,
                    std::ptr::null_mut(),
                    0x1 | 0x4, // CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER
                    &IID_ITASKBAR_LIST3,
                    &mut ptr,
                );
                if hr < 0 || ptr.is_null() {
                    log::warn!("Failed to create ITaskbarList3: HRESULT 0x{:08x}", hr);
                    return None;
                }
                let taskbar = ptr as *mut ITaskbarList3;
                let init_hr = ((*(*taskbar).vtbl).hr_init)(taskbar);
                if init_hr < 0 {
                    log::warn!("ITaskbarList3::HrInit failed: 0x{:08x}", init_hr);
                    ((*(*taskbar).vtbl).release)(taskbar);
                    return None;
                }
                Some(Self { taskbar, hwnd })
            }
        }

        pub fn set_progress(&self, current: u64, total: u64) {
            unsafe {
                ((*(*self.taskbar).vtbl).set_progress_value)(
                    self.taskbar,
                    self.hwnd,
                    current,
                    total,
                );
            }
        }

        pub fn set_state(&self, state: &str) {
            let flag = match state {
                "normal" => TBPF_NORMAL,
                "paused" => TBPF_PAUSED,
                _ => TBPF_NOPROGRESS,
            };
            unsafe {
                ((*(*self.taskbar).vtbl).set_progress_state)(self.taskbar, self.hwnd, flag);
            }
        }
    }

    impl Drop for TaskbarProgress {
        fn drop(&mut self) {
            unsafe {
                ((*(*self.taskbar).vtbl).release)(self.taskbar);
            }
        }
    }

    pub static TASKBAR: Mutex<Option<TaskbarProgress>> = Mutex::new(None);
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn taskbar_set_progress(position_ms: u64, duration_ms: u64) {
    if let Ok(guard) = taskbar::TASKBAR.lock() {
        if let Some(ref tb) = *guard {
            tb.set_progress(position_ms, duration_ms);
        }
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn taskbar_set_state(state: String) {
    if let Ok(guard) = taskbar::TASKBAR.lock() {
        if let Some(ref tb) = *guard {
            tb.set_state(&state);
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn taskbar_set_progress(_position_ms: u64, _duration_ms: u64) {}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn taskbar_set_state(_state: String) {}

// ========================================================================
// OS Media Controls (SMTC / MPRIS)
// ========================================================================

struct MediaControlsState {
    controls: Mutex<Option<souvlaki::MediaControls>>,
    is_playing: AtomicBool,
    // Cached metadata so we can amend individual fields (e.g. duration only)
    cached_title: Mutex<String>,
    cached_artist: Mutex<Option<String>>,
    cached_album: Mutex<Option<String>>,
    cached_cover_url: Mutex<Option<String>>,
    cached_duration_ms: Mutex<Option<u64>>,
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
    // Cache metadata so we can amend individual fields later
    *state.cached_title.lock().unwrap() = title.clone();
    *state.cached_artist.lock().unwrap() = artist.clone();
    *state.cached_album.lock().unwrap() = album.clone();
    *state.cached_cover_url.lock().unwrap() = cover_url.clone();
    *state.cached_duration_ms.lock().unwrap() = duration_ms;

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
fn media_notify_duration(
    state: State<'_, MediaControlsState>,
    duration_ms: u64,
) {
    debug!("media_notify_duration: {}ms", duration_ms);
    *state.cached_duration_ms.lock().unwrap() = Some(duration_ms);

    // Re-apply metadata with updated duration
    let title = state.cached_title.lock().unwrap().clone();
    let artist = state.cached_artist.lock().unwrap().clone();
    let album = state.cached_album.lock().unwrap().clone();
    let cover_url = state.cached_cover_url.lock().unwrap().clone();

    if let Ok(mut guard) = state.controls.lock() {
        if let Some(controls) = guard.as_mut() {
            controls
                .set_metadata(souvlaki::MediaMetadata {
                    title: Some(&title),
                    artist: artist.as_deref(),
                    album: album.as_deref(),
                    cover_url: cover_url.as_deref(),
                    duration: Some(std::time::Duration::from_millis(duration_ms)),
                })
                .ok();
        }
    }
}

#[tauri::command]
fn media_notify_volume(
    _state: State<'_, MediaControlsState>,
    volume: f64,
) {
    // souvlaki 0.8 does not expose set_volume — log for future use
    debug!("media_notify_volume: {} (not forwarded, souvlaki lacks set_volume)", volume);
}

#[tauri::command]
fn media_notify_rate(
    _state: State<'_, MediaControlsState>,
    rate: f64,
) {
    // TODO: souvlaki v0.8 doesn't support playback rate — log for now
    debug!("media_notify_rate: {} (not forwarded — souvlaki limitation)", rate);
}

#[tauri::command]
fn media_notify_shuffle(
    _state: State<'_, MediaControlsState>,
    enabled: bool,
) {
    // TODO: souvlaki v0.8 doesn't support shuffle property
    debug!("media_notify_shuffle: {} (not forwarded — souvlaki limitation)", enabled);
}

#[tauri::command]
fn media_notify_repeat(
    _state: State<'_, MediaControlsState>,
    mode: String,
) {
    // TODO: souvlaki v0.8 doesn't support repeat/loop property
    debug!("media_notify_repeat: {} (not forwarded — souvlaki limitation)", mode);
}

#[tauri::command]
fn media_notify_queue(
    _state: State<'_, MediaControlsState>,
    can_next: bool,
    can_prev: bool,
) {
    // TODO: souvlaki v0.8 doesn't support CanGoNext/CanGoPrevious toggles
    debug!("media_notify_queue: canNext={}, canPrev={} (not forwarded — souvlaki limitation)", can_next, can_prev);
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
// CLI Arguments
// ========================================================================

#[derive(Debug, Clone)]
struct CliArgs {
    fullscreen: bool,
    tv_mode: bool,
    log_level: Option<String>,
}

fn parse_cli_args() -> CliArgs {
    use clap::{Arg, Command};

    let matches = Command::new("jellyfin-desktop")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Jellyfin Desktop Client (Tauri)")
        .arg(Arg::new("fullscreen").long("fullscreen").action(clap::ArgAction::SetTrue).help("Start in fullscreen mode"))
        .arg(Arg::new("windowed").long("windowed").action(clap::ArgAction::SetTrue).help("Start in windowed mode"))
        .arg(Arg::new("tv").long("tv").action(clap::ArgAction::SetTrue).help("Start in TV layout mode"))
        .arg(Arg::new("desktop").long("desktop").action(clap::ArgAction::SetTrue).help("Start in desktop layout mode (default)"))
        .arg(Arg::new("log-level").long("log-level").value_name("LEVEL").help("Log level: debug, info, warn, error"))
        .get_matches();

    let fullscreen = if matches.get_flag("windowed") {
        false
    } else {
        matches.get_flag("fullscreen")
    };

    let tv_mode = if matches.get_flag("desktop") {
        false
    } else {
        matches.get_flag("tv")
    };

    let log_level = matches.get_one::<String>("log-level").cloned();

    CliArgs {
        fullscreen,
        tv_mode,
        log_level,
    }
}

// ========================================================================
// Entry Point
// ========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_args = parse_cli_args();

    let log_level = match cli_args.log_level.as_deref() {
        Some("error") => log::LevelFilter::Error,
        Some("warn")  => log::LevelFilter::Warn,
        Some("info")  => log::LevelFilter::Info,
        Some("debug") => log::LevelFilter::Debug,
        Some("trace") => log::LevelFilter::Trace,
        _ => log::LevelFilter::Debug,
    };

    let cli_args_clone = cli_args.clone();

    tauri::Builder::default()
        // Single-instance: focus existing window when second instance is launched
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
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
                .level(log_level)
                .build(),
        )
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            info!("Jellyfin Desktop starting up");
            let cli = &cli_args_clone;

            if cli.fullscreen {
                info!("CLI: --fullscreen requested");
            }
            if cli.tv_mode {
                info!("CLI: --tv mode requested");
            }

            // Manage cancellation flag for server connectivity checks
            app.manage(ConnectivityCancelFlag(Arc::new(AtomicBool::new(false))));

            // Log the app data directory for easy log file discovery
            if let Ok(log_dir) = app.path().app_log_dir() {
                info!("Log directory: {}", log_dir.display());
            }
            if let Ok(data_dir) = app.path().app_data_dir() {
                info!("Data directory: {}", data_dir.display());
            }

            // If CLI requests TV mode, inject a script to override jmpInfo.mode
            let mode_script = if cli.tv_mode {
                "\n(function(){ if(window.jmpInfo) window.jmpInfo.mode = 'tv'; })();\n"
            } else {
                ""
            };

            // Create main window from config, adding our initialization scripts
            // The window has "create": false in tauri.conf.json so Tauri doesn't auto-create it
            info!("Creating main webview window with injection scripts");
            let config = app.config().app.windows[0].clone();
            let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .initialization_script(INJECTION_SCRIPT)
                .initialization_script(MPV_VIDEO_PLAYER)
                .initialization_script(MPV_AUDIO_PLAYER)
                .initialization_script(INPUT_PLUGIN);

            if !mode_script.is_empty() {
                builder = builder.initialization_script(mode_script);
            }

            let win = builder.build()?;
            info!("Main window created successfully");

            // ── Initialize Windows Taskbar progress ──
            #[cfg(target_os = "windows")]
            {
                use raw_window_handle::{HasWindowHandle, RawWindowHandle};
                if let Ok(handle) = win.window_handle() {
                    if let RawWindowHandle::Win32(h) = handle.as_raw() {
                        let hwnd = h.hwnd.get() as isize;
                        if let Some(tb) = taskbar::TaskbarProgress::new(hwnd) {
                            *taskbar::TASKBAR.lock().unwrap() = Some(tb);
                            info!("Windows taskbar progress initialized");
                        }
                    }
                }
            }

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
                            let action = match &event {
                                MediaControlEvent::Play => "play",
                                MediaControlEvent::Pause => "pause",
                                MediaControlEvent::Toggle => "play_pause",
                                MediaControlEvent::Next => "next_track",
                                MediaControlEvent::Previous => "previous_track",
                                MediaControlEvent::Stop => "stop",
                                MediaControlEvent::Seek(SeekDirection::Forward) => "seek_forward",
                                MediaControlEvent::Seek(SeekDirection::Backward) => "seek_backward",
                                MediaControlEvent::SeekBy(direction, duration) => {
                                    let ms = duration.as_millis() as i64;
                                    let signed_ms = match direction {
                                        SeekDirection::Forward => ms,
                                        SeekDirection::Backward => -ms,
                                    };
                                    let _ = app_handle.emit("media-seek-by", signed_ms);
                                    return;
                                }
                                MediaControlEvent::SetPosition(pos) => {
                                    let ms = pos.0.as_millis() as u64;
                                    let _ = app_handle.emit("media-set-position", ms);
                                    return;
                                }
                                MediaControlEvent::SetVolume(vol) => {
                                    let _ = app_handle.emit("media-set-volume", *vol);
                                    return;
                                }
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
                            cached_title: Mutex::new(String::new()),
                            cached_artist: Mutex::new(None),
                            cached_album: Mutex::new(None),
                            cached_cover_url: Mutex::new(None),
                            cached_duration_ms: Mutex::new(None),
                        });
                        info!("OS media controls initialized (SMTC/MPRIS)");
                    }
                    Err(e) => {
                        warn!("Failed to initialize OS media controls: {:?}", e);
                        app.manage(MediaControlsState {
                            controls: Mutex::new(None),
                            is_playing: AtomicBool::new(false),
                            cached_title: Mutex::new(String::new()),
                            cached_artist: Mutex::new(None),
                            cached_album: Mutex::new(None),
                            cached_cover_url: Mutex::new(None),
                            cached_duration_ms: Mutex::new(None),
                        });
                    }
                }
            }

            // ── Apply CLI fullscreen override ──
            if cli.fullscreen {
                let _ = win.set_fullscreen(true);
            }

            // ── Restore saved window geometry (only if not overridden by CLI) ──
            if !cli.fullscreen {
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
            }

            // ── Debounced geometry save on move/resize ──
            let debounce_timer: Arc<Mutex<Option<std::time::Instant>>> =
                Arc::new(Mutex::new(None));

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
            cancel_server_connectivity,
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
            window_set_title,
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
            system_network_addresses,
            // Power
            power_set_screensaver_enabled,
            // Taskbar
            taskbar_set_progress,
            taskbar_set_state,
            // Media Controls
            media_notify_playback_state,
            media_notify_metadata,
            media_notify_stop,
            media_notify_position,
            media_notify_duration,
            media_notify_volume,
            media_notify_rate,
            media_notify_shuffle,
            media_notify_repeat,
            media_notify_queue,
            // Logging
            log_from_webview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
