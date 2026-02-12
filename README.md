# Jellyfin Desktop (Tauri)

A lightweight Jellyfin desktop client built with Tauri v2 + WebView2, designed to replace the Qt WebEngine-based Jellyfin Desktop. Qt lacks Windows on ARM support and the WebView2-based approach gives better battery life on Snapdragon laptops. This client integrates libmpv for direct playback of all formats with native subtitle rendering (SRT, ASS, PGS, etc.).

## Target Platform

- **Windows 11 ARM64** (Snapdragon). The original Qt app's WebEngine doesn't compile for ARM64/MinGW. This Tauri app uses the system's native WebView2 (Edge Chromium, already on Windows 11 ARM64) and libmpv for video.
- Should also work on x86_64 Windows with no changes.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  jellyfin-web (loaded from user's server)        │
│  ┌────────────────────────────────────────────┐  │
│  │  injection.js (initialization_script)       │  │
│  │  - window.api shim (Tauri IPC)             │  │
│  │  - window.NativeShell.AppHost              │  │
│  │  - window.jmpInfo (settings + metadata)    │  │
│  │  - Device profile (MPV-expanded codecs)    │  │
│  │  - Settings modal (video, audio, subtitle) │  │
│  │  - Console → Rust file log bridge          │  │
│  ├────────────────────────────────────────────┤  │
│  │  mpvVideoPlayer.js  — video player plugin  │  │
│  │  mpvAudioPlayer.js  — audio player plugin  │  │
│  │  inputPlugin.js     — keyboard + media keys│  │
│  └────────────────────────────────────────────┘  │
│         ▲ invoke()  ▼ listen()                   │
├──────────────────────────────────────────────────┤
│  Tauri Rust Backend (lib.rs)                     │
│  - Server connectivity (reqwest)                 │
│  - Settings persistence (tauri-plugin-store)     │
│  - Window management + geometry save/restore     │
│  - Power management (SetThreadExecutionState)    │
│  - OS media controls (souvlaki: SMTC / MPRIS)   │
│  - Structured logging (tauri-plugin-log)         │
│  - GitHub release update checker                 │
├──────────────────────────────────────────────────┤
│  libmpv (tauri-plugin-libmpv)                    │
│  - Renders behind transparent WebView2           │
│  - Full codec support, native subtitles          │
│  - lib/libmpv-2.dll + lib/libmpv-wrapper.dll     │
└──────────────────────────────────────────────────┘
```

### How it works

1. App launches → shows a local connect screen (`index.html` + `src/main.ts`)
2. User enters their Jellyfin server URL → Rust backend hits `/System/Info/Public` to verify
3. On success, URL is saved to `tauri-plugin-store` and webview navigates to `{server}/web/index.html`
4. Four initialization scripts are injected at document_start on every page via separate `.initialization_script()` calls on the `WebviewWindowBuilder`: `injection.js`, `mpvVideoPlayer.js`, `mpvAudioPlayer.js`, `inputPlugin.js`
5. `injection.js` creates `window.NativeShell`, `window.api`, `window.jmpInfo` — jellyfin-web detects these and activates native client mode
6. The `window.api` shim maps Qt's QWebChannel signal pattern (`.connect(cb)`/`.disconnect(cb)`) to Tauri's `invoke()`/`listen()`
7. `mpvVideoPlayer.js` and `mpvAudioPlayer.js` register as jellyfin-web player plugins via `NativeShell.AppHost.getPlugins()`
8. `inputPlugin.js` binds keyboard shortcuts and bridges OS media control events to jellyfin-web playback commands

## Current State

### ✅ Completed

- **Tauri v2 project scaffolded** and compiling on aarch64-pc-windows-msvc
- **Server connect screen** — local HTML/CSS/TS page with dark Jellyfin theme
- **Server connectivity check** — Rust `reqwest` hits Jellyfin `/System/Info/Public`, returns server name/version
- **Server URL persistence** — saved/loaded via `tauri-plugin-store` in `settings.json`
- **Navigation** — after connect, webview navigates to jellyfin-web on the server
- **libmpv integrated** via `tauri-plugin-libmpv` (v0.3.2) — plugin initialized, DLLs bundled in `src-tauri/lib/`
- **JS injection bridge** (`src-tauri/native/injection.js`):
  - `window.api` shim with full method coverage matching the original Qt QWebChannel API
  - `window.NativeShell.AppHost` with `init()`, `supports()`, `getDeviceProfile()`, `getPlugins()`, `exit()`, `openClientSettings()`
  - `window.apiPromise` resolving immediately (Tauri IPC is always available)
  - `window.jmpInfo` with version, platform detection, settings proxy with reactive persistence
  - Settings for video (transcode/quality), audio (device/passthrough), and subtitles (size/font/color)
  - Settings descriptions metadata (type, default, name, options) for settings modal
  - Signal-to-Tauri-event adapter (`createSignal()`) for `.connect()`/`.disconnect()` pattern
  - Device profile expanded for MPV (comprehensive direct-play codecs and native subtitle formats)
  - Client settings modal (dynamically built HTML, per-category settings with reset to defaults)
  - Console → Rust file log bridge (intercepts `console.log/warn/error/debug/info`)
  - Unhandled error and promise rejection capture
- **Player plugins** (ported from original Qt app, injected as initialization scripts):
  - `mpvVideoPlayer.js` — video player plugin with subtitle handling (external URL + embedded track switching), WebView transparency management, playback state tracking
  - `mpvAudioPlayer.js` — audio player plugin with fade-out on stop, audio device settings (exclusive mode, passthrough codecs, channel config, normalization)
  - `inputPlugin.js` — keyboard shortcut mapping (play/pause, volume, seek, fullscreen, subtitles, audio track) and OS media control event bridging (SMTC/MPRIS → jellyfin-web)
- **Rust backend commands** (31 commands across 7 categories):
  - **Server**: `check_server_connectivity`, `save_server_url`, `get_saved_server`, `navigate_to_server`
  - **Settings**: `settings_get_value`, `settings_set_value`, `settings_set_values`, `settings_delete_section`, `settings_get_all`
  - **Window**: `window_set_fullscreen`, `window_is_fullscreen`, `window_set_always_on_top`, `window_is_always_on_top`, `window_raise`, `window_set_cursor_visible`, `window_save_geometry`
  - **System**: `system_hello`, `system_open_external_url`, `system_exit`, `system_restart`, `system_debug_info`, `system_check_for_updates`
  - **Power**: `power_set_screensaver_enabled` (Windows `SetThreadExecutionState` FFI)
  - **Media controls**: `media_notify_playback_state`, `media_notify_metadata`, `media_notify_stop`, `media_notify_position`
  - **Logging**: `log_from_webview`
- **OS media controls** — souvlaki integration for SMTC (Windows) / MPRIS (Linux)
- **Window geometry** — save/restore position, size, and maximized state (debounced 900ms on move/resize)
- **Structured logging** — `tauri-plugin-log` with stdout + file targets
- **GitHub update checker** — checks GitHub releases, emits `system-update-info` event

### 🔧 In Progress (MPV Playback)

The libmpv plugin is integrated and initialized, and the player JS plugins are ported. The remaining work is end-to-end testing and refinement of the MPV playback pipeline:
- Verifying video/audio playback with the tauri-plugin-libmpv backend
- WebView2 transparency toggling during playback (video shows through transparent overlay)
- Subtitle rendering validation (SRT, ASS, PGS, DVDSub — external + embedded)
- Edge cases: seek, track switching, playback rate, subtitle delay

## Project Structure

```
jellyfin-tauri/
├── index.html                  # Server connect page (local, shown at startup)
├── jellyfin-icon.svg           # App icon (SVG source)
├── package.json                # npm deps + scripts (dev, build, preview, tauri)
├── tsconfig.json               # TypeScript config (ES2020, strict)
├── vite.config.ts              # Vite bundler config (port 1420, Tauri HMR)
├── src/
│   ├── main.ts                 # Connect screen logic (server check, save URL, navigate)
│   └── styles.css              # Jellyfin dark theme for connect screen
├── src-tauri/
│   ├── Cargo.toml              # Rust deps (see Dependencies below)
│   ├── tauri.conf.json         # App config: transparent window, withGlobalTauri, CSP null
│   ├── build.rs                # Tauri build script
│   ├── capabilities/
│   │   └── default.json        # Tauri permissions (window, event, store, shell, opener, log, libmpv)
│   ├── icons/                  # App icons (ico, icns, png in multiple sizes)
│   ├── lib/                    # libmpv Windows DLLs (bundled as resources)
│   │   ├── libmpv-2.dll
│   │   └── libmpv-wrapper.dll
│   ├── native/
│   │   ├── injection.js        # JS bridge injected into jellyfin-web
│   │   ├── mpvVideoPlayer.js   # Video player plugin (ported from Qt app)
│   │   ├── mpvAudioPlayer.js   # Audio player plugin with fade-out
│   │   └── inputPlugin.js      # Keyboard shortcuts + OS media key bridging
│   └── src/
│       ├── main.rs             # Entry point (calls lib::run)
│       └── lib.rs              # All Tauri commands + plugin setup
```

## Dependencies

### Rust (src-tauri/Cargo.toml)

| Crate | Version | Purpose |
|-------|---------|---------|
| `tauri` | 2 | Core framework |
| `tauri-plugin-libmpv` | 0.3.2 | MPV video player backend |
| `tauri-plugin-store` | 2 | Persistent JSON settings |
| `tauri-plugin-log` | 2 | Structured file + stdout logging |
| `tauri-plugin-shell` | 2 | Subprocess execution |
| `tauri-plugin-opener` | 2 | Open external URLs |
| `reqwest` | 0.12 | HTTP client (`native-tls` feature) |
| `souvlaki` | 0.8 | OS media controls (SMTC on Windows, MPRIS on Linux) |
| `serde` / `serde_json` | 1 | JSON serialization |
| `tokio` | 1 | Async runtime |
| `raw-window-handle` | 0.6 | Window handle interop (for souvlaki) |
| `open` | 5 | Open URLs in default browser |
| `log` | 0.4 | Logging facade |

### npm (package.json)

| Package | Purpose |
|---------|---------|
| `@tauri-apps/api` | Core Tauri IPC |
| `@tauri-apps/plugin-opener` | External URL opening |
| `@tauri-apps/plugin-shell` | Shell execution |
| `@tauri-apps/plugin-store` | Settings persistence |
| `tauri-plugin-libmpv-api` | MPV player JS API |
| `typescript` | TypeScript compiler (dev) |
| `vite` | Frontend bundler (dev) |
| `@tauri-apps/cli` | Tauri CLI (dev) |

## Build & Run

**Prerequisites:** Rust (aarch64-pc-windows-msvc or x86_64), Node.js, npm

```bash
# Install frontend dependencies
npm install

# Dev mode (hot-reload frontend, debug Rust)
npm run tauri dev

# Release build (no installer)
npm run tauri build -- --no-bundle

# Binary output:
# src-tauri/target/release/jellyfin-tauri.exe
```

**Important build note:** Do NOT use `rustls-tls` feature for reqwest — it pulls in the `ring` crate which fails to compile on ARM64 without MSVC build tools (missing `assert.h`). Use `native-tls` instead (Windows SChannel, no C compilation needed).

## Key Technical Details

### The QWebChannel → Tauri IPC Mapping

The original app used Qt's QWebChannel to expose C++ objects as `window.api`:
```javascript
// Original Qt pattern:
new QWebChannel(qt.webChannelTransport, (channel) => {
    window.api = channel.objects;
    // api.player.load(url, ...) — calls C++ Q_INVOKABLE method
    // api.player.playing.connect(cb) — subscribes to C++ signal
});
```

Our replacement in `injection.js`:
```javascript
// Tauri pattern:
window.api = {
    player: {
        load: (url, ...) => invoke('player_load', { url, ... }),  // Tauri command
        playing: createSignal('player-playing'),  // Tauri event listener
        // signal.connect(cb) → listen('player-playing', cb)
        // signal.disconnect(cb) → unlisten()
    }
};
window.apiPromise = Promise.resolve(window.api);  // Immediately available
```

### Subtitle Handling

MPV handles all subtitle formats natively:
- **External subs** (SRT/ASS/VTT): `--sub-file=URL` — MPV fetches and renders directly
- **Embedded subs** (SRT/ASS in MKV): `--sid=N` — MPV reads directly from the container
- **Bitmap subs** (PGS/DVDSub): `--sid=N` — MPV renders the bitmap overlay natively

### Server Response Format

`GET {server}/System/Info/Public` returns:
```json
{
    "ServerName": "My Server",
    "Version": "10.10.3",
    "Id": "abc123...",
    "LocalAddress": "http://192.168.1.100:8096"
}
```

Note: Our `ServerInfo` struct uses `#[serde(rename = "ServerName")]` etc. because the Jellyfin API uses PascalCase.

### Window Transparency

The window has `"transparent": true` in `tauri.conf.json`. The `tauri-plugin-libmpv` renders MPV as a child window behind the transparent WebView2. During normal browsing the web content is opaque. During video playback, `mpvVideoPlayer.js` manages transparency so the video shows through the overlay.

### CSP is Disabled

`"csp": null` in `tauri.conf.json` — required because we're loading arbitrary jellyfin-web pages from the user's server. The security model relies on the user only connecting to their own server.

### Window Creation

The main window has `"create": false` in `tauri.conf.json`. It is created programmatically in the `setup()` callback in `lib.rs` via `WebviewWindowBuilder::from_config()`, which allows injecting four initialization scripts (`injection.js`, `mpvVideoPlayer.js`, `mpvAudioPlayer.js`, `inputPlugin.js`) before any page scripts run. This is what makes the QWebChannel replacement work — the shim is in place before jellyfin-web checks for `window.NativeShell`.

### Settings Persistence

Settings are stored via `tauri-plugin-store` (typically at `AppData/Roaming/jellyfin-tauri/state/settings.json`). The store holds the server URL, window geometry, and all user-configurable settings organized by section (`main`, `video`, `audio`, `subtitles`). Settings changes emit Tauri events for reactive updates in the JS layer.

### OS Media Controls

The app integrates with the OS media transport controls (SMTC on Windows, MPRIS on Linux) via souvlaki. The `inputPlugin.js` sends metadata, position, and playback state to Rust via `media_notify_*` commands, and receives control events (play/pause/stop/next/previous) back from the OS.
