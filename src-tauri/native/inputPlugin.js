(function () {
    'use strict';

    // Only run on the jellyfin-web page
    if (!window.location.pathname.includes('/web')) return;
    // Guard against double-injection
    if (window._inputPlugin) return;

    // ====================================================================
    // Action Map: native action names → jellyfin-web inputManager commands
    // ====================================================================
    const actionMap = {
        'play_pause':           'playpause',
        'play':                 'play',
        'pause':                'pause',
        'stop':                 'stop',
        'seek_forward':         'fastforward',
        'seek_backward':        'rewind',
        'cycle_audio':          'changeaudiotrack',
        'cycle_audio_back':     'changeaudiotrack',
        'cycle_subtitles':      'changesubtitletrack',
        'cycle_subtitles_back': 'changesubtitletrack',
        'toggle_subtitles':     'changesubtitletrack',
        'increase_volume':      'volumeup',
        'decrease_volume':      'volumedown',
        'step_backward':        'previouschapter',
        'step_forward':         'nextchapter',
        'enter':                'select',
        'back':                 'back',
        'cycle_aspect':         'changezoom',
        'next_track':           'next',
        'previous_track':       'previous',
        'mute':                 'togglemute',
    };

    // ====================================================================
    // Key Map: keyboard key values → native action names
    // ====================================================================
    const keyMap = {
        // Playback
        ' ':                'play_pause',
        'p':                'play_pause',
        'P':                'play_pause',
        'x':                'stop',
        'X':                'stop',

        // Audio / Subtitles
        'a':                'cycle_audio',
        'A':                'cycle_audio',
        'l':                'cycle_subtitles',
        'L':                'cycle_subtitles',
        's':                'toggle_subtitles',
        'S':                'toggle_subtitles',

        // Volume
        '+':                'increase_volume',
        '=':                'increase_volume',
        '-':                'decrease_volume',

        // Seeking
        'PageUp':           'seek_backward',
        'PageDown':         'seek_forward',
        'Home':             'step_backward',
        'End':              'step_forward',

        // Navigation
        'F11':              'host:fullscreen',
        'Escape':           'back',
        'Backspace':        'back',
        'Enter':            'enter',

        // Advanced
        'z':                'cycle_aspect',
        'Z':                'cycle_aspect',
        'i':                'host:toggleDebug',
        'I':                'host:toggleDebug',

        // Browser media keys
        'MediaPlayPause':   'play_pause',
        'MediaTrackNext':   'next_track',
        'MediaTrackPrevious': 'previous_track',
        'MediaStop':        'stop',
    };

    // Ctrl+ combos
    const ctrlKeyMap = {
        'a':                'cycle_audio_back',
        'A':                'cycle_audio_back',
        'l':                'cycle_subtitles_back',
        'L':                'cycle_subtitles_back',
        'q':                'host:close',
        'Q':                'host:close',
        'w':                'host:close',
        'W':                'host:close',
    };

    // Alt+ combos
    const altKeyMap = {
        'Enter':            'host:fullscreen',
    };

    // Tags where keyboard shortcuts should NOT fire
    const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

    // Tauri IPC helper
    const invoke = window.__TAURI__.core.invoke;

    // ====================================================================
    // InputPlugin class
    // ====================================================================
    class InputPlugin {
        constructor({ events, playbackManager, inputManager }) {
            this.name = 'Native Input Plugin';
            this.type = 'input';
            this.id = 'nativeinput';
            this.priority = 1;

            this._events = events;
            this._playbackManager = playbackManager;
            this._inputManager = inputManager;

            this._positionInterval = null;
            this._lastPositionMs = 0;
            this._boundKeyHandler = this._onKeyDown.bind(this);
            this._boundEventHandlers = {};

            this._setupNativeInputSignal();
            this._setupKeyboardShortcuts();
            this._setupNativeControlSignals();
            this._setupPlaybackEventBridge();
            this._setupOsMediaControlEvents();

            console.log('[InputPlugin] Initialized');
        }

        // ================================================================
        // Phase 1A: Native → JS action remapping (via Tauri event signals)
        // ================================================================
        _setupNativeInputSignal() {
            if (window.api && window.api.input && window.api.input.hostInput) {
                window.api.input.hostInput.connect((action) => {
                    this._dispatchAction(action);
                });
            }
        }

        // ================================================================
        // Phase 4: Keyboard shortcut handling
        // ================================================================
        _setupKeyboardShortcuts() {
            document.addEventListener('keydown', this._boundKeyHandler, true);
        }

        _onKeyDown(e) {
            // Don't intercept when user is typing in form fields
            const active = document.activeElement;
            if (active) {
                if (INPUT_TAGS.has(active.tagName)) return;
                if (active.isContentEditable || active.contentEditable === 'true') return;
                // Also skip if inside a dialog's input area
                if (active.closest && active.closest('[contenteditable="true"]')) return;
            }

            let action = null;

            if (e.ctrlKey && !e.altKey && !e.metaKey) {
                action = ctrlKeyMap[e.key];
            } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
                action = altKeyMap[e.key];
            } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
                action = keyMap[e.key];
            }

            if (!action) return;

            // Dispatch the action
            if (this._dispatchAction(action)) {
                e.preventDefault();
                e.stopPropagation();
            }
        }

        // ================================================================
        // Common action dispatcher
        // ================================================================
        _dispatchAction(action) {
            // Handle host: prefixed actions locally
            if (action.startsWith('host:')) {
                this._dispatchHostAction(action);
                return true;
            }

            const command = actionMap[action];
            if (!command) {
                console.warn('[InputPlugin] Unknown action:', action);
                return false;
            }

            if (this._inputManager) {
                this._inputManager.handleCommand(command);
            } else {
                console.warn('[InputPlugin] inputManager not available, cannot dispatch:', command);
                return false;
            }
            return true;
        }

        _dispatchHostAction(action) {
            const api = window.api;
            switch (action) {
                case 'host:fullscreen':
                    if (api && api.window) {
                        api.window.isFullscreen().then(fs => {
                            api.window.setFullscreen(!fs);
                        });
                    }
                    break;
                case 'host:close':
                    if (api && api.system) {
                        api.system.exit();
                    }
                    break;
                case 'host:toggleDebug':
                    // Toggle mpv stats overlay if available
                    invoke('plugin:libmpv|command_string', { command: 'script-binding stats/display-stats-toggle' }).catch(() => {});
                    break;
                default:
                    console.warn('[InputPlugin] Unknown host action:', action);
            }
        }

        // ================================================================
        // Phase 5: OS media control events (SMTC/MPRIS → JS)
        // ================================================================
        _setupOsMediaControlEvents() {
            const { listen } = window.__TAURI__.event;
            this._unlistenMediaControl = listen('media-control-event', (event) => {
                const action = event.payload;
                console.log('[InputPlugin] OS media control event:', action);
                this._dispatchAction(action);
            });

            // SeekBy: OS requests relative seek (payload = signed ms, + forward, - backward)
            this._unlistenMediaSeekBy = listen('media-seek-by', (event) => {
                const offsetMs = event.payload;
                console.log('[InputPlugin] OS media seek-by:', offsetMs, 'ms');
                const pm = this._playbackManager;
                try {
                    const currentMs = pm.currentTime ? pm.currentTime() : 0;
                    const targetMs = Math.max(0, currentMs + offsetMs);
                    const player = pm.getCurrentPlayer();
                    if (player) {
                        pm.seek(targetMs * 10000, player); // ticks
                    }
                } catch (e) {
                    console.warn('[InputPlugin] SeekBy failed:', e);
                }
            });

            // SetPosition: OS requests absolute seek (payload = ms)
            this._unlistenMediaSetPosition = listen('media-set-position', (event) => {
                const posMs = event.payload;
                console.log('[InputPlugin] OS media set-position:', posMs, 'ms');
                const pm = this._playbackManager;
                try {
                    const player = pm.getCurrentPlayer();
                    if (player) {
                        pm.seek(posMs * 10000, player); // ticks
                    }
                } catch (e) {
                    console.warn('[InputPlugin] SetPosition failed:', e);
                }
            });

            // SetVolume: OS requests volume change (payload = 0.0-1.0)
            this._unlistenMediaSetVolume = listen('media-set-volume', (event) => {
                const vol = event.payload;
                console.log('[InputPlugin] OS media set-volume:', vol);
                const pm = this._playbackManager;
                try {
                    const player = pm.getCurrentPlayer();
                    if (player) {
                        pm.setVolume(Math.round(vol * 100), player);
                    }
                } catch (e) {
                    console.warn('[InputPlugin] SetVolume failed:', e);
                }
            });
        }

        // ================================================================
        // Phase 2: Native → JS playback control signals (volume, rate, seek)
        // ================================================================
        _setupNativeControlSignals() {
            const api = window.api;
            if (!api || !api.input) return;

            const pm = this._playbackManager;

            if (api.input.volumeChanged) {
                api.input.volumeChanged.connect((vol) => {
                    const player = pm.getCurrentPlayer();
                    if (player) {
                        // jellyfin-web volume is 0-100
                        pm.setVolume(Math.round(vol * 100), player);
                    }
                });
            }

            if (api.input.rateChanged) {
                api.input.rateChanged.connect((rate) => {
                    const player = pm.getCurrentPlayer();
                    if (player) {
                        pm.setPlaybackRate(rate, player);
                    }
                });
            }

            if (api.input.positionSeek) {
                api.input.positionSeek.connect((ms) => {
                    const player = pm.getCurrentPlayer();
                    if (player) {
                        // jellyfin-web seek uses ticks (1 tick = 10,000 ns = 0.01 ms)
                        pm.seek(ms * 10000, player);
                    }
                });
            }
        }

        // ================================================================
        // Phase 3: Playback event → api.player.notify* bridge
        // ================================================================
        _setupPlaybackEventBridge() {
            const events = this._events;
            const pm = this._playbackManager;
            const api = window.api;
            if (!api || !api.player) return;

            const on = (eventName, handler) => {
                events.on(pm, eventName, handler);
                this._boundEventHandlers[eventName] = handler;
            };

            // --- playbackstart ---
            on('playbackstart', (_e, state) => {
                api.player.notifyPlaybackState('Playing');

                // Inhibit screensaver during playback
                api.power.setScreensaverEnabled(false);

                // Set taskbar progress to normal (green)
                invoke('taskbar_set_state', { state: 'normal' }).catch(() => {});

                // Helper: safely resolve the current item
                const resolveItem = () => {
                    if (state && state.item) return state.item;
                    // Only call currentItem() when the player is registered
                    if (pm.getCurrentPlayer && pm.getCurrentPlayer() && pm.currentItem) {
                        return pm.currentItem();
                    }
                    return null;
                };

                // Helper: push metadata + duration once we have an item
                const notifyMeta = (item) => {
                    if (!item) return;
                    try {
                        const serverUrl = this._getServerUrl();
                        api.player.notifyMetadata(item, serverUrl);
                    } catch (err) {
                        console.warn('[InputPlugin] Error notifying metadata:', err);
                    }
                    try {
                        const durationMs = pm.duration ? pm.duration() : 0;
                        if (durationMs > 0) {
                            api.player.notifyDurationChange(durationMs);
                        }
                    } catch (_) {}
                };

                // Try immediately
                let item = null;
                try { item = resolveItem(); } catch (_) {}

                if (item) {
                    notifyMeta(item);
                    // Update window title with current media name
                    try {
                        const title = item.SeriesName
                            ? `${item.SeriesName} - ${item.Name} — Jellyfin Desktop`
                            : `${item.Name || 'Playing'} — Jellyfin Desktop`;
                        api.window.setTitle(title).catch(() => {});
                    } catch (_) {}
                } else {
                    // Player not registered yet — retry a few times with back-off
                    let retries = 0;
                    const maxRetries = 5;
                    const retryDelay = 200; // ms
                    const retryTimer = setInterval(() => {
                        retries++;
                        try { item = resolveItem(); } catch (_) {}
                        if (item || retries >= maxRetries) {
                            clearInterval(retryTimer);
                            if (item) {
                                notifyMeta(item);
                            } else {
                                console.warn('[InputPlugin] Could not resolve current item after retries');
                            }
                        }
                    }, retryDelay);
                }

                // Start position update interval
                this._startPositionInterval();
            });

            // --- playing / unpause ---
            on('unpause', () => {
                api.player.notifyPlaybackState('Playing');
                invoke('taskbar_set_state', { state: 'normal' }).catch(() => {});
            });

            // --- pause ---
            on('pause', () => {
                api.player.notifyPlaybackState('Paused');
                invoke('taskbar_set_state', { state: 'paused' }).catch(() => {});
            });

            // --- playbackstop ---
            on('playbackstop', () => {
                api.player.notifyPlaybackStop(false);
                this._stopPositionInterval();
                this._lastPositionMs = 0;

                // Re-enable screensaver when playback stops
                api.power.setScreensaverEnabled(true);

                // Clear taskbar progress
                invoke('taskbar_set_state', { state: 'none' }).catch(() => {});

                // Restore default window title
                api.window.setTitle('Jellyfin Desktop').catch(() => {});
            });

            // --- volumechange ---
            on('volumechange', () => {
                try {
                    const vol = pm.getVolume ? pm.getVolume() : (pm.volume ? pm.volume() : 0);
                    // Normalize to 0.0–1.0
                    api.player.notifyVolumeChange(vol / 100);
                } catch (_) {}
            });

            // --- repeatmodechange ---
            on('repeatmodechange', () => {
                try {
                    const mode = pm.getRepeatMode ? pm.getRepeatMode() : (pm.repeatMode ? pm.repeatMode() : 'RepeatNone');
                    api.player.notifyRepeatChange(mode);
                } catch (_) {}
            });

            // --- shufflequeuemodechange ---
            on('shufflequeuemodechange', () => {
                try {
                    const enabled = pm.getQueueShuffleMode ? pm.getQueueShuffleMode() !== 'Sorted' : false;
                    api.player.notifyShuffleChange(enabled);
                } catch (_) {}
            });
        }

        // ================================================================
        // Position tracking with seek detection
        // ================================================================
        _startPositionInterval() {
            this._stopPositionInterval();
            this._lastPositionMs = 0;

            this._positionInterval = setInterval(() => {
                try {
                    const pm = this._playbackManager;
                    const currentMs = pm.currentTime ? pm.currentTime() : 0;

                    if (currentMs > 0) {
                        // Seek detection: if position jumped more than 2000ms
                        if (this._lastPositionMs > 0 && Math.abs(currentMs - this._lastPositionMs) > 2000) {
                            window.api.player.notifySeek(currentMs);
                        }

                        window.api.player.notifyPosition(currentMs);
                        this._lastPositionMs = currentMs;

                        // Update taskbar progress bar
                        const durationMs = pm.duration ? pm.duration() : 0;
                        if (durationMs > 0) {
                            invoke('taskbar_set_progress', {
                                positionMs: Math.round(currentMs),
                                durationMs: Math.round(durationMs),
                            }).catch(() => {});
                        }
                    }
                } catch (_) {}
            }, 500);
        }

        _stopPositionInterval() {
            if (this._positionInterval) {
                clearInterval(this._positionInterval);
                this._positionInterval = null;
            }
        }

        // ================================================================
        // Helpers
        // ================================================================
        _getServerUrl() {
            try {
                // Try to get from jellyfin-web's ApiClient
                if (window.ApiClient && window.ApiClient.serverAddress) {
                    return window.ApiClient.serverAddress();
                }
                // Fallback: try from the page URL
                if (window.jmpInfo && window.jmpInfo.serverUrl) {
                    return window.jmpInfo.serverUrl;
                }
            } catch (_) {}
            return '';
        }

        // ================================================================
        // Cleanup
        // ================================================================
        destroy() {
            document.removeEventListener('keydown', this._boundKeyHandler, true);
            this._stopPositionInterval();

            // Re-enable screensaver on cleanup
            try {
                window.api.power.setScreensaverEnabled(true);
            } catch (_) {}

            // Unsubscribe from OS media control events
            if (this._unlistenMediaControl) {
                this._unlistenMediaControl.then(fn => fn());
                this._unlistenMediaControl = null;
            }
            if (this._unlistenMediaSeekBy) {
                this._unlistenMediaSeekBy.then(fn => fn());
                this._unlistenMediaSeekBy = null;
            }
            if (this._unlistenMediaSetPosition) {
                this._unlistenMediaSetPosition.then(fn => fn());
                this._unlistenMediaSetPosition = null;
            }
            if (this._unlistenMediaSetVolume) {
                this._unlistenMediaSetVolume.then(fn => fn());
                this._unlistenMediaSetVolume = null;
            }

            // Unsubscribe from playback events
            const events = this._events;
            const pm = this._playbackManager;
            if (events && pm) {
                for (const [eventName, handler] of Object.entries(this._boundEventHandlers)) {
                    events.off(pm, eventName, handler);
                }
            }
            this._boundEventHandlers = {};

            console.log('[InputPlugin] Destroyed');
        }
    }

    // ====================================================================
    // Register as plugin factory
    // ====================================================================
    window._inputPlugin = function () {
        return InputPlugin;
    };

    console.log('[InputPlugin] Plugin factory registered');
})();
