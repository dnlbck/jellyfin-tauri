# Jellyfin Desktop (Tauri)

A lightweight Jellyfin desktop client built with Tauri v2 + WebView2, designed to replace the Qt WebEngine-based Jellyfin Desktop. The primary motivation is **native subtitle handling** — the Jellyfin server is poor at subtitle track transcoding, so users end up downloading videos and watching in VLC. This client will use libmpv for direct playback of all formats (SRT, ASS, PGS, etc.) without server transcoding.

## Target Platform

- **Windows 11 ARM64** (Snapdragon). The original Qt app's WebEngine doesn't compile for ARM64/MinGW. This Tauri app uses the system's native WebView2 (Edge Chromium, already on Windows 11 ARM64) and will use libmpv for video.
- Should also work on x86_64 Windows with no changes.

## Architecture

```
┌─────────────────────────────────────────────┐
│  jellyfin-web (loaded from user's server)   │
│  ┌─────────────────────────────────────┐    │
│  │  injection.js (initialization_script)│    │
│  │  - window.api shim (Tauri IPC)      │    │
│  │  - window.NativeShell.AppHost       │    │
│  │  - window.jmpInfo                   │    │
│  │  - Device profile                   │    │
│  └─────────────────────────────────────┘    │
│         ▲ invoke()  ▼ listen()              │
├─────────────────────────────────────────────┤
│  Tauri Rust Backend (lib.rs)                │
│  - Server connectivity (reqwest)            │
│  - Settings persistence (tauri-plugin-store)│
│  - Window management                       │
│  - Power mgmt (SetThreadExecutionState)     │
│  - Player commands (STUBS — needs libmpv)   │
├─────────────────────────────────────────────┤
│  libmpv (Phase 2 — NOT YET IMPLEMENTED)     │
│  - Renders behind transparent WebView2      │
│  - Full codec support, native subtitles     │
└─────────────────────────────────────────────┘
```

### How it works

1. App launches → shows a local connect screen (`index.html` + `src/main.ts`)
2. User enters their Jellyfin server URL → Rust backend hits `/System/Info/Public` to verify
3. On success, URL is saved to `tauri-plugin-store` and webview navigates to `{server}/web/index.html`
4. `injection.js` runs at document_start on every page (via `WebviewWindowBuilder::initialization_script`)
5. injection.js creates `window.NativeShell`, `window.api`, `window.jmpInfo` — jellyfin-web detects these and activates native client mode
6. The `window.api` shim maps Qt's QWebChannel signal pattern (`.connect(cb)`/`.disconnect(cb)`) to Tauri's `invoke()`/`listen()`

## Current State (What Works)

### ✅ Completed

- **Tauri v2 project scaffolded** and compiling on aarch64-pc-windows-msvc
- **Server connect screen** — local HTML/CSS/TS page with dark Jellyfin theme
- **Server connectivity check** — Rust `reqwest` hits Jellyfin `/System/Info/Public`, returns server name/version
- **Server URL persistence** — saved/loaded via `tauri-plugin-store` in `settings.json`
- **Navigation** — after connect, webview navigates to jellyfin-web on the server
- **JS injection bridge** (`src-tauri/native/injection.js`):
  - `window.api` shim with all method stubs matching the original Qt QWebChannel API
  - `window.NativeShell.AppHost` with `init()`, `supports()`, `getDeviceProfile()`, `getPlugins()`, `exit()`
  - `window.apiPromise` resolving immediately (Tauri IPC is always available)
  - `window.jmpInfo` with version, platform detection, settings proxy with reactive persistence
  - Signal-to-Tauri-event adapter (`createSignal()`) for `.connect()`/`.disconnect()` pattern
  - Device profile (conservative HTML5-compatible — to be expanded for MPV)
- **Rust backend commands**:
  - `check_server_connectivity`, `save_server_url`, `get_saved_server`, `navigate_to_server`
  - `settings_get_value`, `settings_set_value`, `settings_get_all`
  - `window_set_fullscreen`, `window_is_fullscreen`
  - `system_hello`, `system_open_external_url`, `system_exit`, `system_check_for_updates`
  - `power_set_screensaver_enabled` (Windows `SetThreadExecutionState` FFI)
  - All `player_*` commands registered as stubs (return errors, no MPV yet)
- **Build passing** — `npm run tauri build -- --no-bundle` produces `jellyfin-tauri.exe`

### ❌ Not Started (Phase 2 — MPV Integration)

This is the **entire reason this project exists**. Everything above is scaffolding to get jellyfin-web running in a native window. The critical missing piece is **libmpv playback** so that:
- All video/audio codecs play natively without server transcoding
- Subtitles (SRT, ASS, SSA, PGS, DVDSub) render natively via MPV
- External subtitle files load directly
- The server doesn't need to burn-in/transcode subtitle tracks

## What Needs To Be Done

### 1. Integrate libmpv via `tauri-plugin-libmpv`

The existing Tauri plugin for libmpv: https://github.com/nicholasgasior/tauri-plugin-libmpv

This plugin renders MPV behind a transparent WebView2 window — the webview acts as an overlay for UI while MPV renders video underneath.

**Steps:**
```bash
cd C:\Users\chris\jellyfin-tauri
npm run tauri add libmpv
npx tauri-plugin-libmpv-api setup-lib  # downloads ARM64 wrapper DLLs
```

This should:
- Add `tauri-plugin-libmpv` to `Cargo.toml`
- Download `libmpv-wrapper.dll` + `libmpv-2.dll` into `src-tauri/lib/`
- Add the npm package `@nicholasgasior/tauri-plugin-libmpv-api`

Then update `tauri.conf.json` to bundle the DLLs:
```json
"resources": ["lib/*"]
```

And register the plugin in `lib.rs`:
```rust
.plugin(tauri_plugin_libmpv::init())
```

**NOTE**: If that plugin doesn't have ARM64 Windows builds or doesn't work, the fallback approach is:
- Download `libmpv-2.dll` for ARM64 from https://sourceforge.net/projects/mpv-player-windows/files/ or build from MSYS2 (`pacman -S mingw-w64-clang-aarch64-mpv`)
- Use the `libmpv` Rust crate directly (https://crates.io/crates/libmpv) or `mpv` crate
- Create a custom Tauri plugin that wraps libmpv's C API via Rust FFI
- The key libmpv functions needed: `mpv_create`, `mpv_initialize`, `mpv_command`, `mpv_set_property`, `mpv_observe_property`, `mpv_set_wakeup_callback`

### 2. Implement Player Commands in lib.rs

Replace the stub `player_*` commands with real libmpv calls. The current stubs are at the bottom of `src-tauri/src/lib.rs`. Each needs to talk to an MPV instance.

**Required state management:**
```rust
struct MpvState {
    mpv: /* libmpv handle */,
    // Track playback state for JS queries
    is_playing: bool,
    is_paused: bool,
    duration_ms: f64,
    position_ms: f64,
    volume: f64,
    muted: bool,
    playback_rate: f64,
}
```

**Commands to implement:**

| Command | What it does | MPV equivalent |
|---------|-------------|----------------|
| `player_load(url, params, audio_index, subtitle_index, subtitle_arg)` | Start playback | `mpv_command(["loadfile", url])` then set aid/sid |
| `player_stop()` | Stop playback | `mpv_command(["stop"])` |
| `player_pause()` | Pause | `mpv_set_property("pause", true)` |
| `player_play()` | Unpause | `mpv_set_property("pause", false)` |
| `player_seek_to(ms)` | Seek to position | `mpv_command(["seek", seconds, "absolute"])` |
| `player_set_volume(volume)` | Set volume 0-100 | `mpv_set_property("volume", volume)` |
| `player_set_muted(muted)` | Mute/unmute | `mpv_set_property("mute", muted)` |
| `player_set_audio_stream(index)` | Switch audio track | `mpv_set_property("aid", index)` |
| `player_set_subtitle_stream(index)` | Switch subtitle track | `mpv_set_property("sid", index)` (-1 = off) |
| `player_set_subtitle_delay(delay)` | Subtitle timing offset | `mpv_set_property("sub-delay", seconds)` |
| `player_set_playback_rate(rate)` | Playback speed | `mpv_set_property("speed", rate)` |

**Critical subtitle logic from the original app** (in `mpvVideoPlayer.js`):
- External subtitles: URL is passed as `subtitle_arg` in format `'#,' + deliveryUrl` — strip the `#,` prefix and pass to MPV as `--sub-file=URL`
- Embedded subtitles: `subtitle_index` is a **1-based relative index by codec type** (e.g., "2nd SRT track"), calculated by `getRelativeIndexByType()` in the original code. MPV uses its own track numbering, so you may need to map.
- Disabled subtitles: `subtitle_index = -1`

### 3. MPV Event Loop → Tauri Events

MPV fires property-change callbacks. These need to emit Tauri events that the JS injection picks up:

```rust
// In a background thread watching MPV events:
app.emit("player-playing", ()).ok();
app.emit("player-paused", ()).ok();
app.emit("player-stopped", ()).ok();
app.emit("player-finished", ()).ok();  // EOF reached
app.emit("player-position-update", position_ms).ok();
app.emit("player-duration-changed", duration_ms).ok();
app.emit("player-error", error_message).ok();
app.emit("player-playback-rate-changed", rate).ok();
```

Use `mpv_observe_property` on: `pause`, `eof-reached`, `time-pos`, `duration`, `speed`, `volume`, `mute`

### 4. Update the Device Profile for MPV

In `injection.js`, the `getDeviceProfile()` function currently returns a conservative HTML5-compatible profile. Once MPV is working, expand it to tell the Jellyfin server "I can direct-play everything":

```javascript
DirectPlayProfiles: [
    {
        Type: 'Video',
        // MPV plays essentially everything
        Container: 'mp4,m4v,mkv,webm,avi,mov,wmv,ts,mpg,mpeg,flv,3gp,ogv',
        VideoCodec: 'h264,h265,hevc,vp8,vp9,av1,mpeg2video,mpeg4,msmpeg4v3,theora,wmv3,vc1',
        AudioCodec: 'aac,mp3,opus,vorbis,flac,ac3,eac3,dts,truehd,pcm_s16le,pcm_s24le,wma',
    },
    {
        Type: 'Audio',
        Container: 'mp3,aac,ogg,opus,flac,m4a,m4b,wav,wma,webm,dsf,dff,ape,mka',
    },
],
SubtitleProfiles: [
    // All of these render natively in MPV — no server transcoding needed!
    { Format: 'srt',    Method: 'External' },
    { Format: 'ass',    Method: 'External' },
    { Format: 'ssa',    Method: 'External' },
    { Format: 'sub',    Method: 'External' },
    { Format: 'smi',    Method: 'External' },
    { Format: 'vtt',    Method: 'External' },
    { Format: 'srt',    Method: 'Embed' },
    { Format: 'ass',    Method: 'Embed' },
    { Format: 'ssa',    Method: 'Embed' },
    { Format: 'pgssub', Method: 'Embed' },
    { Format: 'dvdsub', Method: 'Embed' },
    { Format: 'dvbsub', Method: 'Embed' },
    { Format: 'pgs',    Method: 'Embed' },
    { Format: 'sub',    Method: 'Embed' },
],
```

Also update `NativeShell.AppHost.supports()` to enable subtitle settings:
```javascript
'subtitleappearancesettings': true,
'subtitleburnsettings': true,
```

And return the MPV player plugins from `getPlugins()`.

### 5. Port mpvVideoPlayer.js and mpvAudioPlayer.js

The original plugins are at `C:\Users\chris\jellyfin-desktop-2.0.0\native\mpvVideoPlayer.js` (900 lines) and `mpvAudioPlayer.js` (358 lines). These register as jellyfin-web player plugins.

**Key points about the original code:**
- They are classes registered via `window._mpvVideoPlayer = mpvVideoPlayer` and picked up by `NativeShell.AppHost.getPlugins()`
- Each has a `canPlayMediaType()`, `canPlayItem()`, `play()`, `stop()`, `pause()`, `unpause()`, `seek()`, `currentTime()`, `duration()`, `volume()`, `setVolume()`, etc.
- `play()` calls `window.api.player.load(url, params, audioIndex, subtitleIndex, subtitleArg)`
- They listen for signals: `api.player.playing.connect(cb)`, `api.player.paused.connect(cb)`, etc.
- `mpvVideoPlayer` has special subtitle handling — see Section 2 above
- `mpvAudioPlayer` has fade-out on stop (ramping volume down over ~500ms)

**For the Tauri version:**
- These can remain mostly the same JS — they already use `window.api.player.*` which our injection.js shim maps to Tauri invoke
- Copy them into `src-tauri/native/`, adjust any remaining Qt-specific references
- Concatenate them into `injection.js` or load them as separate initialization scripts via additional `initialization_script()` calls in `lib.rs`
- Register them: `getPlugins()` should return `[window._mpvVideoPlayer, window._mpvAudioPlayer]` (the class constructors, not instances — jellyfin-web instantiates them)

### 6. WebView Transparency for MPV Rendering

The `tauri-plugin-libmpv` approach renders MPV as a separate Win32 child window behind the WebView2. The webview must be transparent so the video shows through.

**Already configured:**
- `tauri.conf.json` has `"transparent": true` on the window
- `injection.js` device profile is ready

**Still needed:**
- When MPV playback starts, set the WebView2 background to transparent
- The video player container div in jellyfin-web must also be transparent (the original code creates a `videoPlayerContainer` div and sets background to `rgba(0,0,0,0)`)
- When playback stops, restore normal background

This is handled in the original `mpvVideoPlayer.js` with transparency levels — search for `setTransparency` in that file.

### 7. Input Plugin (Nice to Have)

The original `inputPlugin.js` (365 lines) at `C:\Users\chris\jellyfin-desktop-2.0.0\native\inputPlugin.js` handles:
- Keyboard/remote input mapping (play_pause → playpause, etc.)
- MPRIS-like media session notifications (metadata, position, duration, state to Rust)
- Playlist queue state tracking

This is useful for system media key integration but not critical for Phase 2. The input remapping table and event wiring are straightforward to port — they already use `window.api.*` calls.

### 8. Update Plugin (Nice to Have)

The original `updatePlugin.js` (55 lines) checks GitHub releases for new versions and shows a dialog. Low priority.

## Project Structure

```
jellyfin-tauri/
├── index.html              # Server connect page (local, shown at startup)
├── package.json            # npm deps: @tauri-apps/api, plugin-store, plugin-shell
├── tsconfig.json           # TypeScript config
├── vite.config.ts          # Vite bundler config
├── src/
│   ├── main.ts             # Connect screen logic (invoke check_server_connectivity, etc.)
│   └── styles.css          # Jellyfin dark theme for connect screen
├── dist/                   # Vite build output (auto-generated)
├── src-tauri/
│   ├── Cargo.toml          # Rust deps: tauri 2, reqwest, serde, open, plugin-store/shell
│   ├── tauri.conf.json     # App config: transparent window, withGlobalTauri, CSP null
│   ├── build.rs            # Tauri build script
│   ├── capabilities/
│   │   └── default.json    # Tauri permissions (window, event, store, shell, opener)
│   ├── native/
│   │   └── injection.js    # JS bridge injected into jellyfin-web (THE KEY FILE)
│   └── src/
│       ├── main.rs         # Entry point (calls lib::run)
│       └── lib.rs          # All Tauri commands (server, settings, window, system, power, player stubs)
```

## Reference Material

The original Qt-based Jellyfin Desktop 2.0.0 source is at `C:\Users\chris\jellyfin-desktop-2.0.0`. Key files for understanding the original plugin API:

| File | Lines | What it does |
|------|-------|-------------|
| `native/nativeshell.js` | 595 | QWebChannel bridge, NativeShell, device profile, settings modal |
| `native/mpvVideoPlayer.js` | 900 | Video player plugin with subtitle handling |
| `native/mpvAudioPlayer.js` | 358 | Audio player plugin with fade-out |
| `native/inputPlugin.js` | 365 | Input mapping + media session integration |
| `native/updatePlugin.js` | 55 | GitHub release update checker |
| `native/connectivityHelper.js` | 95 | Server connectivity + CSP workaround |
| `native/find-webclient.js` | — | Local webclient discovery (not needed — we load from server) |

## Build & Run

**Prerequisites:** Rust 1.93+ (aarch64-pc-windows-msvc), Node.js 24+, npm 11+

```bash
cd C:\Users\chris\jellyfin-tauri

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

### Subtitle Handling (The Whole Point)

The Jellyfin server's subtitle behavior:
1. **External subs** (SRT/ASS/VTT): Server provides a download URL. Client fetches and renders.
2. **Embedded subs** (SRT/ASS in MKV): Server can extract on-the-fly. Client plays the extracted stream.
3. **Bitmap subs** (PGS/DVDSub): Server must **burn-in** (re-encode entire video) for HTML5 clients. MPV handles these natively.

With MPV:
- External: `--sub-file=URL` — MPV fetches and renders
- Embedded: `--sid=N` — MPV reads directly from container
- Bitmap (PGS): `--sid=N` — MPV renders the bitmap overlay
- No server transcoding ever needed

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

The window has `"transparent": true` in tauri.conf.json. This is for Phase 2: MPV renders as a child window behind the transparent WebView2. During normal browsing the web content is opaque. During video playback, the video player area becomes transparent to show MPV underneath.

### CSP is Disabled

`"csp": null` in tauri.conf.json — required because we're loading arbitrary jellyfin-web pages from the user's server. The security model relies on the user only connecting to their own server.

### Window Creation

The main window has `"create": false` in tauri.conf.json. It is created programmatically in the `setup()` callback in `lib.rs` via `WebviewWindowBuilder::from_config()`, which allows us to call `.initialization_script(INJECTION_SCRIPT)` to inject our JS bridge before any page scripts run. This is what makes the QWebChannel replacement work — the shim is in place before jellyfin-web checks for `window.NativeShell`.
