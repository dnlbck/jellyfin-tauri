// ============================================================================
// Jellyfin Desktop — Tauri Native Shell Injection
// Runs at document_start via WebView2 AddScriptToExecuteOnDocumentCreated
// Replaces the QWebChannel-based bridge from the original Qt app
// ============================================================================
(function () {
    'use strict';

    // Only activate on jellyfin-web pages
    if (!window.location.pathname.includes('/web')) return;

    // Guard against double-injection (e.g. SPA soft navigations)
    if (window.__JELLYFIN_TAURI_INJECTED__) return;
    window.__JELLYFIN_TAURI_INJECTED__ = true;

    console.log('[JellyfinTauri] Injection script running at', window.location.href);

    // ========================================================================
    // Tauri IPC helpers
    // ========================================================================
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    // ========================================================================
    // Console → Rust log file bridge
    // Intercepts console.log/warn/error/debug and forwards to Rust file logger.
    // Original console methods are preserved so browser DevTools still works.
    // ========================================================================
    const _origConsole = {
        log:   console.log.bind(console),
        warn:  console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
        info:  console.info.bind(console),
    };

    function formatArgs(args) {
        return args.map(a => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
            try {
                const s = JSON.stringify(a);
                // JSON.stringify({}) on Error-like objects loses info — detect and fallback
                if (s === '{}' && Object.getPrototypeOf(a) !== Object.prototype) {
                    return String(a);
                }
                return s;
            } catch { return String(a); }
        }).join(' ');
    }

    function forwardLog(level, args) {
        try {
            invoke('log_from_webview', {
                level: level,
                message: formatArgs(args),
                context: 'jellyfin-web',
            }).catch(() => {}); // fire-and-forget, don't break on IPC errors
        } catch (_) {}
    }

    console.log = function (...args) {
        _origConsole.log(...args);
        forwardLog('info', args);
    };
    console.info = function (...args) {
        _origConsole.info(...args);
        forwardLog('info', args);
    };
    console.warn = function (...args) {
        _origConsole.warn(...args);
        forwardLog('warn', args);
    };
    console.error = function (...args) {
        _origConsole.error(...args);
        forwardLog('error', args);
    };
    console.debug = function (...args) {
        _origConsole.debug(...args);
        forwardLog('debug', args);
    };

    // Capture unhandled errors and promise rejections
    window.addEventListener('error', (event) => {
        forwardLog('error', [
            `Uncaught ${event.error?.name || 'Error'}: ${event.message}`,
            `at ${event.filename}:${event.lineno}:${event.colno}`,
        ]);
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const msg = reason?.stack || reason?.message || String(reason);
        forwardLog('error', [`Unhandled promise rejection: ${msg}`]);
    });

    console.log('[JellyfinTauri] Console→file log bridge active');

    /**
     * Creates a signal-like object compatible with the Qt QWebChannel pattern:
     *   signal.connect(callback)   — subscribe
     *   signal.disconnect(callback) — unsubscribe
     * Under the hood, uses Tauri event listeners.
     */
    function createSignal(eventName) {
        const listeners = new Map();
        return {
            connect(callback) {
                const unlistenPromise = listen(eventName, (event) => {
                    const p = event.payload;
                    if (Array.isArray(p)) {
                        callback(...p);
                    } else if (p !== null && p !== undefined) {
                        callback(p);
                    } else {
                        callback();
                    }
                });
                listeners.set(callback, unlistenPromise);
            },
            disconnect(callback) {
                const unlistenPromise = listeners.get(callback);
                if (unlistenPromise) {
                    unlistenPromise.then(fn => fn());
                    listeners.delete(callback);
                }
            }
        };
    }

    // ========================================================================
    // API Shim — replaces window.api created by QWebChannel
    // ========================================================================
    window.api = {
        // Player methods are now handled directly by mpvVideoPlayer.js / mpvAudioPlayer.js
        // via tauri-plugin-libmpv (invoke('plugin:libmpv|...')). This shim provides
        // compatibility stubs for any code that still references window.api.player.
        player: {
            // Outbound notifications (JS → Rust, informational — no-ops for now)
            notifyMetadata:       (item, serverUrl) => {},
            notifyPosition:       (ms)              => {},
            notifyDurationChange: (ms)              => {},
            notifyPlaybackState:  (state)           => {},
            notifyVolumeChange:   (vol)             => {},
            notifyRateChange:     (rate)            => {},
            notifyShuffleChange:  (enabled)         => {},
            notifyRepeatChange:   (mode)            => {},
            notifyQueueChange:    (canNext, canPrev) => {},
            notifyPlaybackStop:   (isNavigating)    => {},
            notifySeek:           (ms)              => {},

            // Legacy signal stubs — kept for compatibility with any addons
            playing:             createSignal('player-playing'),
            paused:              createSignal('player-paused'),
            stopped:             createSignal('player-stopped'),
            finished:            createSignal('player-finished'),
            positionUpdate:      createSignal('player-position-update'),
            durationChanged:     createSignal('player-duration-changed'),
            error:               createSignal('player-error'),
            loading:             createSignal('player-loading'),
            playbackRateChanged: createSignal('player-playback-rate-changed'),
            // Additional signals referenced by original player plugins
            updateDuration:      createSignal('player-duration-changed'),
            buffering:           createSignal('player-buffering'),
            canceled:            createSignal('player-canceled'),
            stateChanged:        createSignal('player-state-changed'),
            videoPlaybackActive: createSignal('player-video-playback-active'),
            windowVisible:       createSignal('player-window-visible'),
            onVideoRecangleChanged: createSignal('player-video-rectangle-changed'),
            onMetaData:          createSignal('player-metadata'),
        },

        settings: {
            allValues: (section)          => invoke('settings_get_all', { section }),
            setValue:  (section, key, val) => invoke('settings_set_value', { section, key, value: val }),
            value:     (section, key)      => invoke('settings_get_value', { section, key }),
            settingsValue: createSignal('settings-value-changed'),
        },

        system: {
            hello:                   (name) => invoke('system_hello', { name }),
            openExternalUrl:         (url)  => invoke('system_open_external_url', { url }),
            exit:                    ()     => invoke('system_exit'),
            checkForUpdates:         ()     => invoke('system_check_for_updates'),
            checkServerConnectivity: (url)  => invoke('check_server_connectivity', { url }),
            updateInfoEmitted:       createSignal('system-update-info'),
            serverConnectivityResult:createSignal('system-server-connectivity-result'),
            pageContentReady:        createSignal('system-page-content-ready'),
        },

        input: {
            hostInput:     createSignal('input-host-input'),
            volumeChanged: createSignal('input-volume-changed'),
            rateChanged:   createSignal('input-rate-changed'),
            positionSeek:  createSignal('input-position-seek'),
        },

        power: {
            setScreensaverEnabled: (enabled) => invoke('power_set_screensaver_enabled', { enabled }),
        },

        display: {},

        window: {
            setFullscreen: (fs) => invoke('window_set_fullscreen', { fullscreen: fs }),
            isFullscreen:  ()   => invoke('window_is_fullscreen'),
        },
    };

    // apiPromise resolves immediately — Tauri IPC is always available
    window.apiPromise = Promise.resolve(window.api);

    // ========================================================================
    // jmpInfo — version & settings info object
    // ========================================================================
    const isWindows = navigator.userAgent.includes('Windows');
    const isMac     = navigator.userAgent.includes('Macintosh');
    const isLinux   = navigator.userAgent.includes('Linux') && !navigator.userAgent.includes('Android');

    window.jmpInfo = {
        version: '2.0.0-tauri',
        mode: 'desktop',
        platform: {
            isWindows: isWindows,
            isMac: isMac,
            isLinux: isLinux,
        },
        settings: {
            main: {},
            video: {
                force_transcode_dovi:  false,
                force_transcode_hdr:   false,
                force_transcode_hi10p: false,
                force_transcode_hevc:  false,
                force_transcode_av1:   false,
                force_transcode_4k:    false,
                always_force_transcode: false,
                max_audio_channels:    '6',
                default_playback_speed: 1,
                aspect: 'auto',
            },
        },
        settingsDescriptions: {
            main: {
                fullscreen:    { type: 'bool', default: false, name: 'Fullscreen' },
                alwaysOnTop:   { type: 'bool', default: false, name: 'Always on Top' },
            },
            video: {
                force_transcode_dovi:  { type: 'bool', default: false, name: 'Force transcode Dolby Vision' },
                force_transcode_hdr:   { type: 'bool', default: false, name: 'Force transcode HDR' },
                force_transcode_hi10p: { type: 'bool', default: false, name: 'Force transcode 10-bit' },
                force_transcode_hevc:  { type: 'bool', default: false, name: 'Force transcode HEVC/H.265' },
                force_transcode_av1:   { type: 'bool', default: false, name: 'Force transcode AV1' },
                force_transcode_4k:    { type: 'bool', default: false, name: 'Force transcode 4K' },
                always_force_transcode: { type: 'bool', default: false, name: 'Always force transcoding' },
                max_audio_channels:    { type: 'select', default: '6', name: 'Max audio channels', options: ['2', '6', '8'] },
                default_playback_speed: { type: 'select', default: '1', name: 'Default playback speed', options: ['0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'] },
            },
        },
        settingsUpdate: [],
        settingsDescriptionsUpdate: [],
    };

    // ========================================================================
    // Codec Profiles — dynamically built from user's force-transcode settings
    // Each enabled flag adds conditions that prevent direct play for that content
    // ========================================================================
    function getCodecProfiles() {
        const vs = window.jmpInfo.settings.video || {};
        const profiles = [];

        // Impossible Width<=0 condition forces server to transcode the codec
        if (vs.force_transcode_hevc) {
            profiles.push({
                Type: 'Video', Codec: 'hevc',
                Conditions: [{ Condition: 'LessThanEqual', Property: 'Width', Value: '0', IsRequired: false }],
            });
        }
        if (vs.force_transcode_av1) {
            profiles.push({
                Type: 'Video', Codec: 'av1',
                Conditions: [{ Condition: 'LessThanEqual', Property: 'Width', Value: '0', IsRequired: false }],
            });
        }
        // 10-bit: only allow bit depth <= 8 → anything higher gets transcoded
        if (vs.force_transcode_hi10p) {
            profiles.push({
                Type: 'Video',
                Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }],
            });
        }
        // 4K: only allow width <= 1920 → anything wider gets transcoded
        if (vs.force_transcode_4k) {
            profiles.push({
                Type: 'Video',
                Conditions: [{ Condition: 'LessThanEqual', Property: 'Width', Value: '1920', IsRequired: false }],
            });
        }
        // HDR: require SDR → all HDR (including DOVI) gets transcoded
        if (vs.force_transcode_hdr) {
            profiles.push({
                Type: 'Video',
                Conditions: [{ Condition: 'Equals', Property: 'VideoRangeType', Value: 'SDR', IsRequired: false }],
            });
        } else if (vs.force_transcode_dovi) {
            // DOVI only: block Dolby Vision range types (but allow HDR10/HLG)
            profiles.push({
                Type: 'Video',
                Conditions: [
                    { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVIWithHDR10', IsRequired: false },
                    { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVIWithHDR10Plus', IsRequired: false },
                    { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVIWithSDR', IsRequired: false },
                    { Condition: 'NotEquals', Property: 'VideoRangeType', Value: 'DOVI', IsRequired: false },
                ],
            });
        }

        return profiles;
    }

    // ========================================================================
    // Settings Modal — shows video/transcode settings when user opens
    // Client Settings from the jellyfin-web dashboard
    // ========================================================================
    function showSettingsModal() {
        // Toggle: remove if already open
        const existing = document.getElementById('jmp-settings-modal');
        if (existing) { existing.remove(); return; }

        const sections = window.jmpInfo.settingsDescriptions || {};
        const settings = window.jmpInfo.settings || {};

        const modal = document.createElement('div');
        modal.id = 'jmp-settings-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;';

        const panel = document.createElement('div');
        panel.style.cssText = 'background:#202020;color:#eee;border-radius:8px;padding:24px 28px;max-width:480px;width:90%;max-height:80vh;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

        const h2 = document.createElement('h2');
        h2.textContent = 'Client Settings';
        h2.style.cssText = 'margin:0 0 20px;font-size:1.3em;font-weight:600;';
        panel.appendChild(h2);

        // Build controls for each section (skip 'main' — handled by jellyfin-web)
        for (const [secName, secDesc] of Object.entries(sections)) {
            if (secName === 'main') continue;
            const secSettings = settings[secName] || {};

            const heading = document.createElement('h3');
            heading.textContent = secName.charAt(0).toUpperCase() + secName.slice(1);
            heading.style.cssText = 'margin:0 0 10px;font-size:1em;color:#888;text-transform:capitalize;';
            panel.appendChild(heading);

            for (const [key, desc] of Object.entries(secDesc)) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 0;';

                const lbl = document.createElement('label');
                lbl.textContent = desc.name || key;
                lbl.style.cssText = 'flex:1;margin-right:12px;font-size:0.95em;';
                row.appendChild(lbl);

                if (desc.type === 'bool') {
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = !!secSettings[key];
                    cb.style.cssText = 'width:18px;height:18px;cursor:pointer;accent-color:#00a4dc;';
                    cb.addEventListener('change', () => {
                        settings[secName][key] = cb.checked;
                        window.api.settings.setValue(secName, key, cb.checked).catch(() => {});
                        window.jmpInfo.settingsUpdate.forEach(fn => { try { fn(secName); } catch(e) {} });
                    });
                    row.appendChild(cb);
                } else if (desc.type === 'select') {
                    const sel = document.createElement('select');
                    sel.style.cssText = 'background:#333;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 8px;font-size:0.9em;';
                    for (const opt of (desc.options || [])) {
                        const o = document.createElement('option');
                        o.value = opt; o.textContent = opt;
                        if (String(secSettings[key]) === String(opt)) o.selected = true;
                        sel.appendChild(o);
                    }
                    sel.addEventListener('change', () => {
                        settings[secName][key] = sel.value;
                        window.api.settings.setValue(secName, key, sel.value).catch(() => {});
                        window.jmpInfo.settingsUpdate.forEach(fn => { try { fn(secName); } catch(e) {} });
                    });
                    row.appendChild(sel);
                }
                panel.appendChild(row);
            }

            const hr = document.createElement('hr');
            hr.style.cssText = 'border:none;border-top:1px solid #333;margin:12px 0;';
            panel.appendChild(hr);
        }

        // Note about restart
        const note = document.createElement('p');
        note.textContent = 'Transcode settings take effect on next playback.';
        note.style.cssText = 'margin:4px 0 16px;font-size:0.85em;color:#888;';
        panel.appendChild(note);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = 'background:#00a4dc;color:#fff;border:none;border-radius:4px;padding:8px 28px;cursor:pointer;font-size:0.95em;';
        closeBtn.addEventListener('click', () => modal.remove());
        panel.appendChild(closeBtn);

        modal.appendChild(panel);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
        document.body.appendChild(modal);
    }

    // ========================================================================
    // Device Profile — tells Jellyfin server what this client supports
    // MPV can direct-play essentially everything — no server transcoding needed
    // ========================================================================
    function getDeviceProfile() {
        const vs = window.jmpInfo.settings.video || {};

        // If always_force_transcode, remove video from direct play
        const directPlayProfiles = vs.always_force_transcode
            ? [
                {
                    Type: 'Audio',
                    Container: 'mp3,aac,ogg,opus,flac,m4a,m4b,wav,wma,webm,dsf,dff,ape,mka,alac,aiff',
                },
            ]
            : [
                {
                    Type: 'Video',
                    Container: 'mp4,m4v,mkv,webm,avi,mov,wmv,ts,mpg,mpeg,flv,3gp,ogv,m2ts,vob,rm,rmvb,asf',
                    VideoCodec: 'h264,h265,hevc,vp8,vp9,av1,mpeg2video,mpeg4,msmpeg4v3,theora,wmv3,vc1,dvvideo,rawvideo',
                    AudioCodec: 'aac,mp3,opus,vorbis,flac,ac3,eac3,dts,truehd,pcm_s16le,pcm_s24le,pcm_s32le,wma,wmapro,alac,amr_nb,amr_wb',
                },
                {
                    Type: 'Audio',
                    Container: 'mp3,aac,ogg,opus,flac,m4a,m4b,wav,wma,webm,dsf,dff,ape,mka,alac,aiff',
                },
            ];

        const maxCh = vs.max_audio_channels || '6';

        var profile = {
            Name: 'Jellyfin Desktop (Tauri + MPV)',
            MaxStaticBitrate:  1000000000,
            MaxStreamingBitrate: 200000000,
            MusicStreamingTranscodingBitrate: 384000,
            TimelineOffsetSeconds: 5,

            DirectPlayProfiles: directPlayProfiles,

            // Fallback transcoding if server insists (shouldn't happen often with MPV)
            TranscodingProfiles: [
                {
                    Container: 'ts',
                    Type: 'Video',
                    AudioCodec: 'aac,mp3,ac3,eac3',
                    VideoCodec: 'h264',
                    Context: 'Streaming',
                    Protocol: 'hls',
                    MaxAudioChannels: maxCh,
                    MinSegments: '1',
                    BreakOnNonKeyFrames: true,
                },
                {
                    Container: 'aac',
                    Type: 'Audio',
                    AudioCodec: 'aac',
                    Context: 'Streaming',
                    Protocol: 'hls',
                    MaxAudioChannels: maxCh === '2' ? '2' : '2',
                },
            ],

            ResponseProfiles: [],
            ContainerProfiles: [],
            CodecProfiles: getCodecProfiles(),

            SubtitleProfiles: [
                // Embed only — MPV reads subtitles directly from the container.
                // We do NOT advertise 'External' delivery because jellyfin-web's
                // playback manager intercepts External text subs and tries to
                // render them via its own htmlVideoPlayer text track system,
                // which crashes since we have no HTML video element.
                // For Direct Play, all subs stay embedded in the container and
                // MPV handles them natively via sid selection.
                { Format: 'srt',    Method: 'Embed' },
                { Format: 'subrip', Method: 'Embed' },
                { Format: 'ass',    Method: 'Embed' },
                { Format: 'ssa',    Method: 'Embed' },
                { Format: 'sub',    Method: 'Embed' },
                { Format: 'smi',    Method: 'Embed' },
                { Format: 'vtt',    Method: 'Embed' },
                { Format: 'pgssub', Method: 'Embed' },
                { Format: 'dvdsub', Method: 'Embed' },
                { Format: 'dvbsub', Method: 'Embed' },
                { Format: 'pgs',    Method: 'Embed' },
            ],
        };

        return profile;
    }

    // ========================================================================
    // NativeShell — jellyfin-web checks for this to detect native clients
    // ========================================================================

    // TRACE: intercept getPlugins to log what plugins jellyfin-web sees
    window.NativeShell = {
        getPlugins: function () {
            // Return string names — pluginManager.loadPlugin looks up
            // window[name], calls it as a factory, then news the result.
            const plugins = [];
            if (window._mpvVideoPlayer) plugins.push('_mpvVideoPlayer');
            if (window._mpvAudioPlayer) plugins.push('_mpvAudioPlayer');
            console.warn('~TRACE~ NativeShell.getPlugins() returning ' + plugins.length + ' plugins: ' + plugins.join(', '));
            return plugins;
        },

        openUrl: function (url) {
            invoke('system_open_external_url', { url: url }).catch(() => {});
        },

        downloadFile: function (downloadInfo) {
            if (downloadInfo && downloadInfo.url) {
                invoke('system_open_external_url', { url: downloadInfo.url }).catch(() => {});
            }
        },

        openClientSettings: function () {
            showSettingsModal();
        },

        AppHost: {
            init: async function () {
                const api = await window.apiPromise;

                // Load saved settings from Tauri store
                try {
                    const settings = await api.settings.allValues('main');
                    window.jmpInfo.settings.main = settings || {};
                } catch (e) {
                    console.warn('[JellyfinTauri] Failed to load settings:', e);
                    window.jmpInfo.settings.main = {};
                }

                // Load video settings
                try {
                    const videoSettings = await api.settings.allValues('video');
                    if (videoSettings && typeof videoSettings === 'object') {
                        // Merge saved values over defaults (keep defaults for any missing keys)
                        for (const [k, v] of Object.entries(videoSettings)) {
                            window.jmpInfo.settings.video[k] = v;
                        }
                    }
                } catch (e) {
                    console.warn('[JellyfinTauri] Failed to load video settings:', e);
                }

                // Apply defaults for missing settings
                const defaults = { fullscreen: false, alwaysOnTop: false };
                for (const [k, v] of Object.entries(defaults)) {
                    if (window.jmpInfo.settings.main[k] === undefined) {
                        window.jmpInfo.settings.main[k] = v;
                    }
                }

                // Apply fullscreen if saved
                if (window.jmpInfo.settings.main.fullscreen) {
                    api.window.setFullscreen(true);
                }

                // Settings proxy — saves to store and notifies listeners
                const settingsHandler = {
                    set(target, prop, value) {
                        target[prop] = value;
                        api.settings.setValue('main', prop, value);
                        window.jmpInfo.settingsUpdate.forEach(fn => {
                            try { fn('main'); } catch (e) { console.error(e); }
                        });
                        return true;
                    }
                };
                window.jmpInfo.settings.main = new Proxy(
                    window.jmpInfo.settings.main,
                    settingsHandler
                );

                // Video settings proxy — same pattern
                const videoSettingsHandler = {
                    set(target, prop, value) {
                        target[prop] = value;
                        api.settings.setValue('video', prop, value);
                        window.jmpInfo.settingsUpdate.forEach(fn => {
                            try { fn('video'); } catch (e) { console.error(e); }
                        });
                        return true;
                    }
                };
                window.jmpInfo.settings.video = new Proxy(
                    window.jmpInfo.settings.video,
                    videoSettingsHandler
                );

                // Listen for settings changes from Rust
                api.settings.settingsValue.connect((data) => {
                    if (data && data.section === 'main' && data.key && data.value !== undefined) {
                        // Update without triggering proxy set (avoid loop)
                        const raw = Object.assign({}, window.jmpInfo.settings.main);
                        raw[data.key] = data.value;
                    }
                });

                // Cursor auto-hide: observe body.mouseIdle class
                const cursorObserver = new MutationObserver((mutations) => {
                    for (const m of mutations) {
                        if (m.attributeName === 'class') {
                            const isIdle = document.body.classList.contains('mouseIdle');
                            // Could emit to Rust for cursor visibility,
                            // but WebView2 handles cursor visibility natively via CSS
                        }
                    }
                });
                // Start observing once body exists
                const startObserving = () => {
                    if (document.body) {
                        cursorObserver.observe(document.body, { attributes: true });
                    } else {
                        document.addEventListener('DOMContentLoaded', () => {
                            cursorObserver.observe(document.body, { attributes: true });
                        });
                    }
                };
                startObserving();

                api.system.hello('jellyfin-desktop-tauri');
                console.log('[JellyfinTauri] NativeShell initialized');
            },

            getDefaultLayout: function () {
                return 'desktop';
            },

            supports: function (command) {
                const features = {
                    'filedownload':                true,
                    'displaylanguage':             true,
                    'externallinks':               true,
                    'fullscreenchange':            true,
                    'targetblank':                 true,
                    'screensaver':                 true,
                    'multiserver':                 true,
                    'otherapppromotions':           false,
                    'subtitleappearancesettings':   true,
                    'subtitleburnsettings':         true,
                    'htmlaudioautoplay':            true,
                    'htmlvideoautoplay':            true,
                    'exitmenu':                    true,
                    'remotecontrol':               true,
                    'remotevideo':                 true,
                    'displaymode':                 true,
                    'fileinput':                   true,
                    'clientsettings':              true,
                };
                return features[command] || false;
            },

            getDeviceProfile: function () {
                return getDeviceProfile();
            },

            deviceName: function () {
                return 'Jellyfin Desktop';
            },

            appName: function () {
                return 'Jellyfin Desktop';
            },

            appVersion: function () {
                return window.jmpInfo.version;
            },

            exit: function () {
                invoke('system_exit');
            },

            getPlugins: function () {
                const plugins = [];
                if (window._mpvVideoPlayer) plugins.push('_mpvVideoPlayer');
                if (window._mpvAudioPlayer) plugins.push('_mpvAudioPlayer');
                return plugins;
            },
        },
    };

    console.log('[JellyfinTauri] NativeShell registered, waiting for jellyfin-web init');

    // ========================================================================
    // Update Checker — listens for update info from Rust side
    // ========================================================================
    window.api.system.updateInfoEmitted.connect((info) => {
        try {
            // info is the redirect URL from GitHub releases, extract version
            const url = typeof info === 'string' ? info : (info && info.url) || '';
            const match = url.match(/\/tag\/v?([\d.]+)/);
            if (!match) return;

            const remoteVersion = match[1];
            const localVersion = window.jmpInfo.version.replace(/[^\d.]/g, '');

            // Simple semver comparison
            const remote = remoteVersion.split('.').map(Number);
            const local = localVersion.split('.').map(Number);
            let isNewer = false;
            for (let i = 0; i < Math.max(remote.length, local.length); i++) {
                const r = remote[i] || 0;
                const l = local[i] || 0;
                if (r > l) { isNewer = true; break; }
                if (r < l) break;
            }

            if (isNewer) {
                console.log(`[JellyfinTauri] Update available: ${remoteVersion} (current: ${localVersion})`);
                // Show a non-blocking notification after page settles
                setTimeout(() => {
                    if (confirm(`Jellyfin Desktop v${remoteVersion} is available (you have v${localVersion}). Open download page?`)) {
                        invoke('system_open_external_url', { url: url }).catch(() => {});
                    }
                }, 3000);
            }
        } catch (e) {
            console.warn('[JellyfinTauri] Update check parse error:', e);
        }
    });
})();
