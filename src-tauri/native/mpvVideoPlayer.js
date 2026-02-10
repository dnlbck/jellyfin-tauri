// ============================================================================
// Jellyfin Desktop — MPV Video Player Plugin (Tauri + tauri-plugin-libmpv)
// Ported from jellyfin-desktop 2.0.0 native/mpvVideoPlayer.js
// Uses tauri-plugin-libmpv JS API directly (no Rust player_* stubs)
// ============================================================================
(function () {
    'use strict';

    // Only activate on jellyfin-web pages
    if (!window.location.pathname.includes('/web')) return;
    if (window._mpvVideoPlayer) return;

    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    const MPV_WINDOW_LABEL = 'main';

    // ========================================================================
    // TRACE LOGGER — dedicated diagnostic chain for audio track switching
    // Writes to both console (with unique prefix) and collects in-memory.
    // In devtools: window.__mpvTrace to see all entries
    //              window.__mpvTraceDump() to copy-paste the log
    // In Rust logs: grep for "~TRACE~" to filter from noise
    // ========================================================================
    const _traceLog = [];
    function trace(msg) {
        const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
        const entry = `[${ts}] ${msg}`;
        _traceLog.push(entry);
        // Use console.warn so it stands out + gets forwarded to Rust logs
        console.warn(`~TRACE~ ${entry}`);
    }
    window.__mpvTrace = _traceLog;
    window.__mpvTraceDump = function () {
        return _traceLog.join('\n');
    };

    // ========================================================================
    // MPV Instance Management (shared with audio player)
    // ========================================================================
    if (!window.__mpvManager) {
        window.__mpvManager = {
            initialized: false,
            initializing: null, // Promise while init is in progress
            eventUnlisten: null,
            eventCallbacks: new Map(), // eventType -> Set<callback>

            async ensureInit(audioOnly) {
                if (this.initialized) return;
                if (this.initializing) return this.initializing;

                this.initializing = (async () => {
                    try {
                        const config = {
                            initialOptions: {
                                'vo': 'gpu-next',
                                'hwdec': 'auto-safe',
                                'keep-open': 'yes',
                                'slang': '',              // don't auto-select subs — we manage this
                                'blend-subtitles': 'video', // burn subs into video frame (required for wid overlay)
                                'sub-visibility': 'yes',  // ensure subtitle rendering is enabled
                            },
                            observedProperties: {
                                'pause': 'flag',
                                'eof-reached': 'flag',
                                'time-pos': 'double',
                                'duration': 'double',
                                'speed': 'double',
                                'volume': 'double',
                                'mute': 'flag',
                                'track-list': 'node',   // track discovery for sub/audio mapping
                                'sid': 'int64',         // active subtitle track
                                'aid': 'int64',         // active audio track
                                'demuxer-cache-duration': 'double', // buffered seconds ahead
                                'seeking': 'flag',       // true while a seek is in progress
                                'idle-active': 'flag',   // true when mpv is idle (no file)
                            },
                        };

                        if (audioOnly) {
                            config.initialOptions['vid'] = 'no';
                        }

                        await invoke('plugin:libmpv|init', {
                            mpvConfig: config,
                            windowLabel: MPV_WINDOW_LABEL,
                        });

                        // Listen for all MPV events
                        this.eventUnlisten = await listen(
                            `mpv-event-${MPV_WINDOW_LABEL}`,
                            (event) => this._dispatchEvent(event.payload)
                        );

                        this.initialized = true;
                        console.log('[MPV] Initialized successfully');
                    } catch (e) {
                        console.error('[MPV] Init failed:', e);
                        throw e;
                    } finally {
                        this.initializing = null;
                    }
                })();

                return this.initializing;
            },

            on(eventType, callback) {
                if (!this.eventCallbacks.has(eventType)) {
                    this.eventCallbacks.set(eventType, new Set());
                }
                this.eventCallbacks.get(eventType).add(callback);
            },

            off(eventType, callback) {
                const cbs = this.eventCallbacks.get(eventType);
                if (cbs) cbs.delete(callback);
            },

            _dispatchEvent(mpvEvent) {
                // Dispatch to specific event type listeners
                const type = mpvEvent.event;
                const cbs = this.eventCallbacks.get(type);
                if (cbs) {
                    for (const cb of cbs) {
                        try { cb(mpvEvent); } catch (e) { console.error('[MPV] Event handler error:', e); }
                    }
                }
                // Also dispatch to '*' listeners
                const allCbs = this.eventCallbacks.get('*');
                if (allCbs) {
                    for (const cb of allCbs) {
                        try { cb(mpvEvent); } catch (e) { console.error('[MPV] Event handler error:', e); }
                    }
                }
            },

            async command(name, args) {
                return invoke('plugin:libmpv|command', {
                    name,
                    args: args || [],
                    windowLabel: MPV_WINDOW_LABEL,
                });
            },

            async setProperty(name, value) {
                return invoke('plugin:libmpv|set_property', {
                    name,
                    value,
                    windowLabel: MPV_WINDOW_LABEL,
                });
            },

            async getProperty(name, format) {
                return invoke('plugin:libmpv|get_property', {
                    name,
                    format: format || 'string',
                    windowLabel: MPV_WINDOW_LABEL,
                });
            },

            async destroy() {
                if (!this.initialized) return;
                try {
                    await invoke('plugin:libmpv|destroy', {
                        windowLabel: MPV_WINDOW_LABEL,
                    });
                } catch (e) {
                    console.warn('[MPV] Destroy error:', e);
                }
                if (this.eventUnlisten) {
                    this.eventUnlisten();
                    this.eventUnlisten = null;
                }
                this.initialized = false;
                this.eventCallbacks.clear();
            },
        };
    }

    const mpv = window.__mpvManager;

    // ========================================================================
    // Helper
    // ========================================================================
    function getMediaStreamAudioTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(function (s) {
            return s.Type === 'Audio';
        });
    }

    // ========================================================================
    // mpvVideoPlayer class — jellyfin-web player plugin interface
    // ========================================================================
    class mpvVideoPlayer {
        constructor({ events, loading, appRouter, globalize, appHost, appSettings, confirm, dashboard }) {
            trace('CONSTRUCTOR called — mpvVideoPlayer being instantiated');
            this.events = events;
            this.loading = loading;
            this.appRouter = appRouter;
            this.globalize = globalize;
            this.appHost = appHost;
            this.appSettings = appSettings;

            // dashboard.default may or may not exist depending on jellyfin-web version
            if (dashboard && dashboard.default && dashboard.default.setBackdropTransparency) {
                this.setTransparency = dashboard.default.setBackdropTransparency.bind(dashboard);
            } else if (dashboard && dashboard.setBackdropTransparency) {
                this.setTransparency = dashboard.setBackdropTransparency.bind(dashboard);
            } else {
                this.setTransparency = () => {};
            }

            this.name = 'MPV Video Player';
            this.type = 'mediaplayer';
            this.id = 'mpvvideoplayer';
            this.syncPlayWrapAs = 'htmlvideoplayer';
            this.priority = -1;
            this.useFullSubtitleUrls = true;
            this.isLocalPlayer = true;
            this.isFetching = false;

            this._videoDialog = undefined;
            this._subtitleTrackIndexToSetOnPlaying = undefined;
            this._audioTrackIndexToSetOnPlaying = undefined;
            this._showTrackOffset = undefined;
            this._currentTrackOffset = undefined;
            this._supportedFeatures = undefined;
            this._currentSrc = undefined;
            this._started = undefined;
            this._timeUpdated = undefined;
            this._currentTime = undefined;
            this._currentPlayOptions = undefined;
            this._lastProfile = undefined;
            this._duration = undefined;
            this._paused = false;
            this._volume = 100;
            this._muted = false;
            this._playRate = undefined;
            this._hasConnection = false;
            this._seeking = false;
            this._cacheDuration = 0;
            this._aspectRatio = 'auto';
            this._mpvTrackList = [];       // raw MPV track-list from property observer
            this._trackMap = new Map();    // jellyfinIndex -> mpvTrackId

            // ================================================================
            // Event handlers (bound to this instance)
            // ================================================================
            this.onEnded = () => {
                this.onEndedInternal();
            };

            this.onTimeUpdate = (time) => {
                if (time && !this._timeUpdated) {
                    this._timeUpdated = true;
                }
                this._currentTime = time;
                this.events.trigger(this, 'timeupdate');
            };

            this.onPlaying = () => {
                trace('onPlaying() fired, _started=' + this._started);
                if (!this._started) {
                    this._started = true;
                    this.loading.hide();

                    const volume = this.getSavedVolume() * 100;
                    this.setVolume(volume, false);
                    this.setPlaybackRate(this.getPlaybackRate());

                    const dlg = this._videoDialog;
                    if (dlg) {
                        dlg.style.backgroundImage = '';
                    }

                    if (this._currentPlayOptions.fullscreen) {
                        this.appRouter.showVideoOsd();
                        if (dlg) {
                            dlg.style.zIndex = 'unset';
                        }
                    }

                    // Apply pending track selections now that file is loaded
                    this._applyPendingTracks();
                }

                if (this._paused) {
                    this._paused = false;
                    this.events.trigger(this, 'unpause');
                }

                this.events.trigger(this, 'playing');
            };

            this.onPause = () => {
                this._paused = true;
                this.events.trigger(this, 'pause');
            };

            this.onError = async (error) => {
                this.removeMediaDialog();
                console.error(`[MPV] media error: ${error}`);

                const errorData = {
                    type: 'mediadecodeerror'
                };

                try {
                    await confirm({
                        title: 'Playback Failed',
                        text: `Playback failed with error "${error}". Retry with transcode? (Note this may hang the player.)`,
                        cancelText: 'Cancel',
                        confirmText: 'Retry'
                    });
                } catch (ex) {
                    errorData.streamInfo = {
                        mediaSource: {
                            SupportsTranscoding: false
                        }
                    };
                }

                this.events.trigger(this, 'error', [errorData]);
            };

            this.onDuration = (duration) => {
                this._duration = duration;
            };

            // ================================================================
            // MPV event dispatcher — routes mpv-event-main events to handlers
            // ================================================================
            this._mpvEventHandler = (mpvEvent) => {
                if (mpvEvent.event === 'property-change') {
                    switch (mpvEvent.name) {
                        case 'time-pos':
                            if (mpvEvent.data != null) {
                                // MPV reports seconds, jellyfin-web expects milliseconds
                                this.onTimeUpdate(mpvEvent.data * 1000);
                            }
                            break;
                        case 'duration':
                            if (mpvEvent.data != null) {
                                this.onDuration(mpvEvent.data * 1000);
                            }
                            break;
                        case 'pause':
                            if (mpvEvent.data === true) {
                                this.onPause();
                            } else if (mpvEvent.data === false && this._started) {
                                this.onPlaying();
                            }
                            break;
                        case 'eof-reached':
                            if (mpvEvent.data === true) {
                                this.onEnded();
                            }
                            break;
                        case 'speed':
                            if (mpvEvent.data != null) {
                                this._playRate = mpvEvent.data;
                            }
                            break;
                        case 'volume':
                            if (mpvEvent.data != null) {
                                this._volume = mpvEvent.data;
                            }
                            break;
                        case 'mute':
                            if (mpvEvent.data != null) {
                                this._muted = mpvEvent.data;
                            }
                            break;
                        case 'demuxer-cache-duration':
                            if (mpvEvent.data != null) {
                                this._cacheDuration = mpvEvent.data;
                            }
                            break;
                        case 'seeking':
                            if (mpvEvent.data === true && !this._seeking) {
                                this._seeking = true;
                                this.events.trigger(this, 'waiting');
                            }
                            break;
                        case 'track-list':
                            if (Array.isArray(mpvEvent.data)) {
                                this._mpvTrackList = mpvEvent.data;
                                console.log('[MPV] track-list updated:', this._mpvTrackList.length, 'tracks');
                                this._rebuildTrackMap();
                            }
                            break;
                        case 'sid':
                            console.log('[MPV] Active subtitle track changed to:', mpvEvent.data);
                            break;
                        case 'aid':
                            console.log('[MPV] Active audio track changed to:', mpvEvent.data);
                            break;
                    }
                } else if (mpvEvent.event === 'file-loaded') {
                    // File loaded, playback starting
                    this.onPlaying();
                } else if (mpvEvent.event === 'playback-restart') {
                    // Seek completed, playback resumed
                    if (this._seeking) {
                        this._seeking = false;
                        this.events.trigger(this, 'playing');
                    }
                } else if (mpvEvent.event === 'end-file') {
                    if (mpvEvent.reason === 'error') {
                        this.onError(mpvEvent.error || 'Unknown playback error');
                    }
                    // 'eof' reason is handled via eof-reached property
                }
            };
        }

        /**
         * Apply pending audio/subtitle track selections after file-loaded.
         * Called once from onPlaying() when _started transitions to true.
         */
        _applyPendingTracks() {
            trace('_applyPendingTracks() pendingAudio=' + this._pendingAudioSetup + ' pendingSub=' + JSON.stringify(this._pendingSubtitleSetup));
            // Audio
            if (this._pendingAudioSetup != null) {
                const aidVal = String(parseInt(this._pendingAudioSetup, 10));
                console.log('[MPV] Applying pending audio track (aid=' + aidVal + ')');
                mpv.setProperty('aid', aidVal).then(() => {
                    console.log('[MPV] aid set successfully');
                }).catch(e => {
                    console.error('[MPV] Failed to set audio track:', e);
                });
                this._pendingAudioSetup = null;
            }

            // Subtitles
            const sub = this._pendingSubtitleSetup;
            if (sub) {
                this._pendingSubtitleSetup = null;
                if (sub.type === 'external') {
                    console.log('[MPV] Applying pending external subtitle:', sub.url);
                    mpv.command('sub-add', [sub.url, 'select']).then(() => {
                        console.log('[MPV] External subtitle loaded successfully');
                    }).catch(e => {
                        console.error('[MPV] sub-add failed:', e);
                    });
                } else if (sub.type === 'embedded') {
                    const sidVal = String(parseInt(sub.sid, 10));
                    console.log('[MPV] Applying pending embedded subtitle (sid=' + sidVal + ')');
                    mpv.setProperty('sid', sidVal).then(() => {
                        console.log('[MPV] sid set successfully');
                    }).catch(e => {
                        console.error('[MPV] Failed to set sid:', e);
                    });
                } else if (sub.type === 'off') {
                    mpv.setProperty('sid', 'no').catch(() => {});
                }
            }
        }

        currentSrc() {
            return this._currentSrc;
        }

        async play(options) {
            trace('play() CALLED — url=' + (options.url || '(none)').slice(-80));
            trace('play() options keys: ' + Object.keys(options).join(','));
            trace('play() mediaSource.DefaultAudioStreamIndex=' + options.mediaSource?.DefaultAudioStreamIndex);
            trace('play() options.AudioStreamIndex=' + options.AudioStreamIndex + ' options.audioStreamIndex=' + options.audioStreamIndex);
            trace('play() _started=' + this._started + ' _currentSrc=' + (this._currentSrc || '(none)').slice(-60));
            // Force ALL subtitle streams to be treated as embedded/non-text.
            // Without this, jellyfin-web's playback manager checks
            // IsTextSubtitleStream and hijacks text-based subs (SRT, ASS, etc.)
            // to render them via its own HTML text track system — which has no
            // HTML video element in our MPV setup. By setting these flags, the
            // playback manager delegates ALL subtitle changes to our player's
            // setSubtitleStreamIndex, and MPV handles them natively from the
            // container.
            if (options.mediaSource && options.mediaSource.MediaStreams) {
                for (const stream of options.mediaSource.MediaStreams) {
                    if (stream.Type === 'Subtitle') {
                        stream.IsTextSubtitleStream = false;
                        stream.IsExternal = false;
                        if (stream.DeliveryMethod === 'External') {
                            stream.DeliveryMethod = 'Embed';
                        }
                    }
                }
            }

            // ================================================================
            // Same-URL fast path: if jellyfin-web's changeStream calls play()
            // with the same file URL (just different audio/subtitle index),
            // skip the full file reload and switch tracks in-place on MPV.
            // This handles the isLocalPlayer changeStream code path where the
            // playback manager restarts playback instead of calling
            // setAudioStreamIndex/setSubtitleStreamIndex directly.
            // ================================================================
            const newUrl = options.url;
            const isSameFile = this._started && this._currentSrc && this._currentSrc === newUrl;
            trace('play() isSameFile=' + isSameFile);

            if (isSameFile) {
                trace('FAST PATH — same URL, switching tracks in-place');
                console.log('[MPV] Same URL detected — switching tracks in-place (changeStream fast path)');
                // Update stored options so track map resolution uses new MediaStreams
                this._currentPlayOptions = options;

                // Determine the desired audio track
                // jellyfin-web may pass the index on mediaSource.DefaultAudioStreamIndex,
                // or as a top-level property on the options, depending on version
                const newAudioIdx = options.AudioStreamIndex ??
                    options.audioStreamIndex ??
                    options.mediaSource?.DefaultAudioStreamIndex;
                const oldAudioIdx = this._audioTrackIndexToSetOnPlaying;
                console.log('[MPV] changeStream audio: old=' + oldAudioIdx + ' new=' + newAudioIdx);

                if (newAudioIdx != null && newAudioIdx >= 0 && newAudioIdx !== oldAudioIdx) {
                    this.setAudioStreamIndex(newAudioIdx);
                }

                // Determine the desired subtitle track
                const newSubIdx = options.SubtitleStreamIndex ??
                    options.subtitleStreamIndex ??
                    options.mediaSource?.DefaultSubtitleStreamIndex;
                const oldSubIdx = this._subtitleTrackIndexToSetOnPlaying;
                console.log('[MPV] changeStream subtitle: old=' + oldSubIdx + ' new=' + newSubIdx);

                if (newSubIdx !== oldSubIdx) {
                    this.setSubtitleStreamIndex(newSubIdx == null ? -1 : newSubIdx);
                }

                // Report playing state to jellyfin-web
                this.events.trigger(this, 'playing');
                return;
            }

            // ================================================================
            // Normal play path: new file
            // ================================================================
            trace('NORMAL PATH — loading new file');
            this._started = false;
            this._timeUpdated = false;
            this._currentTime = null;
            this.resetSubtitleOffset();

            if (options.fullscreen) {
                this.loading.show();
            }

            await this.createMediaElement(options);
            return await this.setCurrentSrc(options);
        }

        getSavedVolume() {
            return this.appSettings.get('volume') || 1;
        }

        tryGetFramerate(options) {
            if (options.mediaSource && options.mediaSource.MediaStreams) {
                for (const stream of options.mediaSource.MediaStreams) {
                    if (stream.Type === 'Video') {
                        return stream.RealFrameRate || stream.AverageFrameRate || null;
                    }
                }
            }
            return null;
        }

        getStreamByIndex(mediaStreams, jellyIndex) {
            for (const stream of mediaStreams) {
                if (stream.Index == jellyIndex) {
                    return stream;
                }
            }
            return null;
        }

        getRelativeIndexByType(mediaStreams, jellyIndex, streamType) {
            let relIndex = 1;
            for (const source of mediaStreams) {
                if (source.Type !== streamType || source.IsExternal) {
                    continue;
                }
                if (source.Index == jellyIndex) {
                    return relIndex;
                }
                relIndex += 1;
            }
            return null;
        }

        /**
         * Resolve a Jellyfin stream index to an MPV track ID.
         * Uses the track-list map if available, falls back to relative index.
         */
        _resolveTrackId(jellyIndex, streamType) {
            // Prefer the track-list-based map (built from actual MPV demuxer data)
            const mapKey = `${streamType}:${jellyIndex}`;
            const mapResult = this._trackMap.has(mapKey) ? this._trackMap.get(mapKey) : null;
            if (mapResult != null) {
                trace('_resolveTrackId(' + jellyIndex + ', ' + streamType + ') -> map hit: ' + mapResult);
                return mapResult;
            }
            // Fallback: relative index counting (original behaviour)
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const fallback = this.getRelativeIndexByType(streams, jellyIndex, streamType);
            trace('_resolveTrackId(' + jellyIndex + ', ' + streamType + ') -> fallback: ' + fallback);
            return fallback;
        }

        /**
         * Build a mapping from Jellyfin stream indices to MPV track IDs
         * by correlating the MPV track-list with Jellyfin's MediaStreams.
         */
        _rebuildTrackMap() {
            this._trackMap.clear();
            const mediaStreams = this._currentPlayOptions?.mediaSource?.MediaStreams;
            if (!mediaStreams || !this._mpvTrackList.length) return;

            // Separate MPV tracks by type
            const mpvByType = { audio: [], sub: [], video: [] };
            for (const t of this._mpvTrackList) {
                if (t.type && mpvByType[t.type]) {
                    mpvByType[t.type].push(t);
                }
            }

            const jellyTypeMap = { 'Audio': 'audio', 'Subtitle': 'sub', 'Video': 'video' };

            for (const [jellyType, mpvType] of Object.entries(jellyTypeMap)) {
                const jellyStreams = mediaStreams.filter(s => s.Type === jellyType && !s.IsExternal);
                const mpvTracks = mpvByType[mpvType] || [];

                // Strategy 1: If counts match, assume same order
                if (jellyStreams.length === mpvTracks.length) {
                    for (let i = 0; i < jellyStreams.length; i++) {
                        const key = `${jellyType}:${jellyStreams[i].Index}`;
                        this._trackMap.set(key, mpvTracks[i].id);
                    }
                    continue;
                }

                // Strategy 2: Try matching by language + codec
                const unmatchedMpv = [...mpvTracks];
                for (const js of jellyStreams) {
                    let bestIdx = -1;
                    let bestScore = -1;
                    for (let i = 0; i < unmatchedMpv.length; i++) {
                        const mt = unmatchedMpv[i];
                        let score = 0;
                        if (js.Language && mt.lang && js.Language.toLowerCase().startsWith(mt.lang.toLowerCase())) score += 2;
                        if (js.Codec && mt.codec && js.Codec.toLowerCase() === mt.codec.toLowerCase()) score += 1;
                        if (score > bestScore) { bestScore = score; bestIdx = i; }
                    }
                    if (bestIdx >= 0) {
                        const key = `${jellyType}:${js.Index}`;
                        this._trackMap.set(key, unmatchedMpv[bestIdx].id);
                        unmatchedMpv.splice(bestIdx, 1);
                    }
                }
            }

            console.log('[MPV] Track map rebuilt:', Object.fromEntries(this._trackMap));
        }

        async setCurrentSrc(options) {
            const val = options.url;
            this._currentSrc = val;
            console.debug(`[MPV] playing url: ${val}`);

            const startMs = (options.playerStartPositionTicks || 0) / 10000;
            this._currentPlayOptions = options;
            this._subtitleTrackIndexToSetOnPlaying =
                options.mediaSource.DefaultSubtitleStreamIndex == null
                    ? -1
                    : options.mediaSource.DefaultSubtitleStreamIndex;
            this._audioTrackIndexToSetOnPlaying = options.mediaSource.DefaultAudioStreamIndex;

            console.log('[MPV] Audio track index:', this._audioTrackIndexToSetOnPlaying);
            console.log('[MPV] Subtitle track index:', this._subtitleTrackIndexToSetOnPlaying);

            // Ensure MPV is initialized (video mode)
            await mpv.ensureInit(false);

            // Stash pending track selections — applied after file-loaded event
            this._pendingSubtitleSetup = null;
            this._pendingAudioSetup = null;

            const streams = options.mediaSource?.MediaStreams || [];

            // Prepare audio track
            const audioRelIndex =
                this._audioTrackIndexToSetOnPlaying != null &&
                this._audioTrackIndexToSetOnPlaying >= 0
                    ? this.getRelativeIndexByType(streams, this._audioTrackIndexToSetOnPlaying, 'Audio')
                    : null;
            if (audioRelIndex != null && audioRelIndex > 0) {
                console.log('[MPV] Will set audio index:', this._audioTrackIndexToSetOnPlaying, '->', audioRelIndex);
                this._pendingAudioSetup = audioRelIndex;
            }

            // Prepare subtitle track
            if (this._subtitleTrackIndexToSetOnPlaying >= 0) {
                const subStream = this.getStreamByIndex(streams, this._subtitleTrackIndexToSetOnPlaying);
                if (subStream && subStream.DeliveryMethod === 'External' && subStream.DeliveryUrl) {
                    // External subtitle — will add via sub-add after file loads
                    let subUrl = subStream.DeliveryUrl;
                    console.log('[MPV] Will load external subtitle URL:', subUrl);
                    this._pendingSubtitleSetup = { type: 'external', url: subUrl };
                } else if (subStream && subStream.DeliveryMethod === 'Embed') {
                    // Embedded subtitle — use relative index within container
                    const relIndex = this.getRelativeIndexByType(
                        streams, this._subtitleTrackIndexToSetOnPlaying, 'Subtitle'
                    );
                    console.log('[MPV] Will set embedded subtitle index:',
                        this._subtitleTrackIndexToSetOnPlaying, '->', relIndex);
                    if (relIndex != null) {
                        this._pendingSubtitleSetup = { type: 'embedded', sid: relIndex };
                    }
                } else {
                    // Fallback: try embedded index anyway
                    const relIndex = this.getRelativeIndexByType(
                        streams, this._subtitleTrackIndexToSetOnPlaying, 'Subtitle'
                    );
                    if (relIndex != null) {
                        this._pendingSubtitleSetup = { type: 'embedded', sid: relIndex };
                    }
                }
            } else {
                // Subtitles off
                this._pendingSubtitleSetup = { type: 'off' };
            }

            // Load the file
            const loadArgs = [val];
            if (startMs > 0) {
                loadArgs.push('replace');
                loadArgs.push(`start=${startMs / 1000}`);
            }
            await mpv.command('loadfile', loadArgs);

            // Unpause (in case keep-open left it paused)
            await mpv.setProperty('pause', false);

            return Promise.resolve();
        }

        setSubtitleStreamIndex(index) {
            console.log('[MPV] setSubtitleStreamIndex called with index:', index);
            this._subtitleTrackIndexToSetOnPlaying = index;

            // If file hasn't loaded yet, stash as pending so _applyPendingTracks picks it up
            if (!this._started) {
                console.log('[MPV] File not loaded yet, deferring subtitle selection');
                if (index < 0 || index == null) {
                    this._pendingSubtitleSetup = { type: 'off' };
                } else {
                    const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
                    const stream = this.getStreamByIndex(streams, index);
                    if (stream && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
                        this._pendingSubtitleSetup = { type: 'external', url: stream.DeliveryUrl };
                    } else {
                        const relIndex = this._resolveTrackId(index, 'Subtitle');
                        if (relIndex != null) {
                            this._pendingSubtitleSetup = { type: 'embedded', sid: relIndex };
                        }
                    }
                }
                return;
            }

            if (index < 0 || index == null) {
                console.log('[MPV] Disabling subtitles (sid=no)');
                mpv.setProperty('sid', 'no').then(() => {
                    console.log('[MPV] Subtitles disabled successfully');
                }).catch(e => {
                    console.error('[MPV] Failed to disable subtitles:', e);
                });
                return;
            }

            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = this.getStreamByIndex(streams, index);

            if (stream && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
                let subUrl = stream.DeliveryUrl;
                console.log('[MPV] Loading external subtitle:', subUrl);
                // 'select' flag makes mpv immediately activate this subtitle
                mpv.command('sub-add', [subUrl, 'select']).then(() => {
                    console.log('[MPV] External subtitle loaded successfully');
                    // Ensure visibility after adding
                    mpv.setProperty('sub-visibility', true).catch(() => {});
                }).catch(e => {
                    console.error('[MPV] sub-add failed:', e);
                });
                return;
            }

            // Embedded subtitle — resolve via track map or relative index
            const relIndex = this._resolveTrackId(index, 'Subtitle');
            const sidVal = relIndex != null ? String(relIndex) : 'no';
            console.log('[MPV] Setting embedded subtitle: jellyfinIdx=' + index + ' -> sid=' + sidVal);
            mpv.setProperty('sid', sidVal).then(() => {
                console.log('[MPV] sid set to ' + sidVal + ' successfully');
                // Ensure visibility after selecting
                if (sidVal !== 'no') {
                    mpv.setProperty('sub-visibility', true).catch(() => {});
                }
            }).catch(e => {
                console.error('[MPV] Failed to set subtitle track:', e);
            });
        }

        setSecondarySubtitleStreamIndex(index) {
            console.log('[MPV] setSecondarySubtitleStreamIndex:', index);
            if (index < 0 || index == null) {
                mpv.setProperty('secondary-sid', 'no').catch(() => {});
                return;
            }
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = this.getStreamByIndex(streams, index);
            if (stream && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
                mpv.command('sub-add', [stream.DeliveryUrl, 'auto']).then(() => {
                    mpv.getProperty('track-list/count', 'int64').then(count => {
                        mpv.setProperty('secondary-sid', String(count)).catch(() => {});
                    }).catch(() => {});
                }).catch(e => console.error('[MPV] secondary sub-add failed:', e));
                return;
            }
            const relIndex = this._resolveTrackId(index, 'Subtitle');
            const val = relIndex != null ? String(relIndex) : 'no';
            mpv.setProperty('secondary-sid', val).catch(() => {});
        }

        resetSubtitleOffset() {
            this._currentTrackOffset = 0;
            this._showTrackOffset = false;
            mpv.setProperty('sub-delay', 0).catch(() => {});
        }

        enableShowingSubtitleOffset() {
            this._showTrackOffset = true;
        }

        disableShowingSubtitleOffset() {
            this._showTrackOffset = false;
        }

        isShowingSubtitleOffsetEnabled() {
            return this._showTrackOffset;
        }

        setSubtitleOffset(offset) {
            const offsetValue = parseFloat(offset);
            this._currentTrackOffset = offsetValue;
            mpv.setProperty('sub-delay', offsetValue);
        }

        getSubtitleOffset() {
            return this._currentTrackOffset;
        }

        isAudioStreamSupported() {
            return true;
        }

        getSupportedAudioStreams() {
            return getMediaStreamAudioTracks(this._currentPlayOptions.mediaSource);
        }

        setAudioStreamIndex(index) {
            trace('setAudioStreamIndex() called with index=' + index + ' _started=' + this._started);
            console.log('[MPV] setAudioStreamIndex called with index:', index);
            this._audioTrackIndexToSetOnPlaying = index;

            // If file hasn't loaded yet, stash as pending so _applyPendingTracks picks it up
            if (!this._started) {
                console.log('[MPV] File not loaded yet, deferring audio selection');
                const relIndex = (index != null && index >= 0)
                    ? this._resolveTrackId(index, 'Audio')
                    : null;
                this._pendingAudioSetup = (relIndex != null && relIndex > 0) ? relIndex : null;
                return;
            }

            const relIndex = (index != null && index >= 0)
                ? this._resolveTrackId(index, 'Audio')
                : null;
            const aidVal = relIndex != null ? String(relIndex) : '1';
            trace('setAudioStreamIndex() -> mpv.setProperty(aid, ' + aidVal + ')');
            console.log('[MPV] Setting audio: jellyfinIdx=' + index + ' -> aid=' + aidVal);
            mpv.setProperty('aid', aidVal).then(() => {
                trace('setAudioStreamIndex() -> aid=' + aidVal + ' SUCCESS');
                console.log('[MPV] aid set to ' + aidVal + ' successfully');
            }).catch(e => {
                trace('setAudioStreamIndex() -> aid=' + aidVal + ' FAILED: ' + e);
                console.error('[MPV] Failed to set audio track:', e);
            });
        }

        onEndedInternal() {
            const stopInfo = {
                src: this._currentSrc
            };

            this.events.trigger(this, 'stopped', [stopInfo]);

            this._currentTime = null;
            this._currentSrc = null;
            this._currentPlayOptions = null;
        }

        stop(destroyPlayer) {
            mpv.command('stop').catch(() => {});
            this.onEndedInternal();

            if (destroyPlayer) {
                this.destroy();
            }
            return Promise.resolve();
        }

        removeMediaDialog() {
            mpv.command('stop').catch(() => {});

            document.body.classList.remove('hide-scroll');

            const dlg = this._videoDialog;
            if (dlg) {
                this.setTransparency(0); // TRANSPARENCY_LEVEL.None
                this._videoDialog = null;
                dlg.parentNode.removeChild(dlg);
            }
        }

        destroy() {
            this.removeMediaDialog();

            this._hasConnection = false;
            mpv.off('property-change', this._mpvEventHandler);
            mpv.off('file-loaded', this._mpvEventHandler);
            mpv.off('playback-restart', this._mpvEventHandler);
            mpv.off('end-file', this._mpvEventHandler);
            this._duration = undefined;
        }

        createMediaElement(options) {
            let dlg = document.querySelector('.videoPlayerContainer');

            if (!dlg) {
                dlg = document.createElement('div');
                dlg.classList.add('videoPlayerContainer');
                dlg.style.position = 'fixed';
                dlg.style.top = '0';
                dlg.style.bottom = '0';
                dlg.style.left = '0';
                dlg.style.right = '0';
                dlg.style.display = 'flex';
                dlg.style.alignItems = 'center';
                // Make transparent so MPV video shows through behind WebView
                dlg.style.backgroundColor = 'transparent';

                if (options.fullscreen) {
                    dlg.style.zIndex = '1000';
                }

                if (options.backdropUrl) {
                    dlg.style.backgroundImage = `url('${options.backdropUrl}')`;
                    dlg.style.backgroundSize = 'cover';
                    dlg.style.backgroundPosition = 'center';
                }

                document.body.insertBefore(dlg, document.body.firstChild);
                this.setTransparency(2); // TRANSPARENCY_LEVEL.Full
                this._videoDialog = dlg;

                // Connect to MPV events
                if (!this._hasConnection) {
                    this._hasConnection = true;
                    mpv.on('property-change', this._mpvEventHandler);
                    mpv.on('file-loaded', this._mpvEventHandler);
                    mpv.on('playback-restart', this._mpvEventHandler);
                    mpv.on('end-file', this._mpvEventHandler);
                }

                if (options.fullscreen) {
                    document.body.classList.add('hide-scroll');
                }
            } else {
                this._videoDialog = dlg;
                if (options.fullscreen) {
                    document.body.classList.add('hide-scroll');
                }
            }

            return Promise.resolve();
        }

        canPlayMediaType(mediaType) {
            const result = (mediaType || '').toLowerCase() === 'video';
            trace('canPlayMediaType(' + mediaType + ') = ' + result);
            return result;
        }

        canPlayItem(item, playOptions) {
            trace('canPlayItem() called for: ' + (item.Name || item.Id || '?'));
            return this.canPlayMediaType(item.MediaType);
        }

        supportsPlayMethod() {
            return true;
        }

        getDeviceProfile(item, options) {
            if (this.appHost.getDeviceProfile) {
                return this.appHost.getDeviceProfile(item, options);
            }
            return Promise.resolve({});
        }

        static getSupportedFeatures() {
            return ['PlaybackRate', 'SetAspectRatio', 'SubtitleOffset', 'SetAudioStreamIndex'];
        }

        supports(feature) {
            if (!this._supportedFeatures) {
                this._supportedFeatures = mpvVideoPlayer.getSupportedFeatures();
            }
            const result = this._supportedFeatures.includes(feature);
            if (feature === 'SetAudioStreamIndex') {
                trace('supports(SetAudioStreamIndex) = ' + result);
            }
            return result;
        }

        isFullscreen() {
            if (window.jmpInfo && window.jmpInfo.settings && window.jmpInfo.settings.main) {
                return window.jmpInfo.settings.main.fullscreen === true;
            }
            return false;
        }

        toggleFullscreen() {
            const current = this.isFullscreen();
            if (window.api && window.api.window) {
                window.api.window.setFullscreen(!current);
                if (window.jmpInfo && window.jmpInfo.settings && window.jmpInfo.settings.main) {
                    window.jmpInfo.settings.main.fullscreen = !current;
                }
            }
        }

        currentTime(val) {
            if (val != null) {
                // Seek — val is milliseconds
                mpv.command('seek', [val / 1000, 'absolute']);
                return;
            }
            return this._currentTime;
        }

        currentTimeAsync() {
            return mpv.getProperty('time-pos', 'double').then(
                (pos) => (pos != null ? pos * 1000 : this._currentTime)
            );
        }

        duration() {
            return this._duration || null;
        }

        canSetAudioStreamIndex() {
            return true;
        }

        setPictureInPictureEnabled() {}
        isPictureInPictureEnabled() { return false; }
        isAirPlayEnabled() { return false; }
        setAirPlayEnabled() {}
        setBrightness() {}
        getBrightness() { return 100; }

        seekable() {
            return Boolean(this._duration);
        }

        pause() {
            mpv.setProperty('pause', true);
        }

        resume() {
            this._paused = false;
            mpv.setProperty('pause', false);
        }

        unpause() {
            mpv.setProperty('pause', false);
        }

        paused() {
            return this._paused;
        }

        setPlaybackRate(value) {
            const playSpeed = +value;
            this._playRate = playSpeed;
            mpv.setProperty('speed', playSpeed);
        }

        getPlaybackRate() {
            if (!this._playRate) {
                const playRate = window.jmpInfo?.settings?.video?.default_playback_speed;
                this._playRate = playRate || 1;
            }
            return this._playRate;
        }

        getSupportedPlaybackRates() {
            return [
                { name: '0.5x', id: 0.5 },
                { name: '0.75x', id: 0.75 },
                { name: '1x', id: 1.0 },
                { name: '1.25x', id: 1.25 },
                { name: '1.5x', id: 1.5 },
                { name: '1.75x', id: 1.75 },
                { name: '2x', id: 2.0 },
                { name: '2.5x', id: 2.5 },
                { name: '3x', id: 3.0 },
                { name: '3.5x', id: 3.5 },
                { name: '4.0x', id: 4.0 },
            ];
        }

        saveVolume(value) {
            if (value) {
                this.appSettings.set('volume', value);
            }
        }

        setVolume(val, save = true) {
            val = Number(val);
            if (!isNaN(val)) {
                this._volume = val;
                if (save) {
                    this.saveVolume(val / 100);
                    this.events.trigger(this, 'volumechange');
                }
                mpv.setProperty('volume', val);
            }
        }

        getVolume() {
            return this._volume;
        }

        volumeUp() {
            this.setVolume(Math.min(this.getVolume() + 2, 100));
        }

        volumeDown() {
            this.setVolume(Math.max(this.getVolume() - 2, 0));
        }

        setMute(mute, triggerEvent = true) {
            this._muted = mute;
            mpv.setProperty('mute', mute);
            if (triggerEvent) {
                this.events.trigger(this, 'volumechange');
            }
        }

        isMuted() {
            return this._muted;
        }

        togglePictureInPicture() {}
        toggleAirPlay() {}

        getBufferedRanges() {
            // Build a buffered range from current position + cached duration
            const currentMs = this._currentTime || 0;
            const cacheMs = (this._cacheDuration || 0) * 1000;
            if (cacheMs > 0 && currentMs >= 0) {
                return [{ start: currentMs, end: currentMs + cacheMs }];
            }
            return [];
        }

        getStats() {
            const playOptions = this._currentPlayOptions || [];
            const categories = [];

            if (!this._currentPlayOptions) {
                return Promise.resolve({ categories });
            }

            const mediaCategory = { stats: [], type: 'media' };
            categories.push(mediaCategory);

            if (playOptions.url) {
                let link = document.createElement('a');
                link.setAttribute('href', playOptions.url);
                const protocol = (link.protocol || '').replace(':', '');
                if (protocol) {
                    mediaCategory.stats.push({
                        label: this.globalize.translate('LabelProtocol'),
                        value: protocol
                    });
                }
                link = null;
            }

            mediaCategory.stats.push({
                label: this.globalize.translate('LabelStreamType'),
                value: 'Video'
            });

            const videoCategory = { stats: [], type: 'video' };
            const audioCategory = { stats: [], type: 'audio' };
            categories.push(videoCategory);
            categories.push(audioCategory);

            // Fetch rich stats from MPV
            const props = [
                ['video-codec', 'string'],
                ['audio-codec-name', 'string'],
                ['width', 'int64'],
                ['height', 'int64'],
                ['video-bitrate', 'double'],
                ['audio-bitrate', 'double'],
                ['video-params/pixelformat', 'string'],
                ['avsync', 'double'],
                ['video-params/average-bpp', 'double'],
                ['container-fps', 'double'],
                ['estimated-vf-fps', 'double'],
                ['video-params/colormatrix', 'string'],
                ['video-params/primaries', 'string'],
                ['video-params/gamma', 'string'],
                ['packet-video-bitrate', 'double'],
                ['packet-audio-bitrate', 'double'],
                ['audio-params/samplerate', 'int64'],
                ['audio-params/channel-count', 'int64'],
            ];

            return Promise.all(
                props.map(([name, fmt]) => mpv.getProperty(name, fmt).catch(() => null))
            ).then(([
                videoCodec, audioCodec, width, height, videoBitrate, audioBitrate,
                pixelFormat, avsync, avgBpp, containerFps, estimatedFps,
                colormatrix, primaries, gamma,
                pktVideoBitrate, pktAudioBitrate, sampleRate, channelCount,
            ]) => {
                if (videoCodec) videoCategory.stats.push({ label: 'Video codec', value: videoCodec });
                if (width && height) videoCategory.stats.push({ label: 'Resolution', value: `${width}×${height}` });
                if (pixelFormat) videoCategory.stats.push({ label: 'Pixel format', value: pixelFormat });
                if (containerFps) videoCategory.stats.push({ label: 'Framerate', value: `${containerFps.toFixed(2)} fps` });
                if (estimatedFps) videoCategory.stats.push({ label: 'Display FPS', value: `${estimatedFps.toFixed(2)} fps` });

                const vBitrate = pktVideoBitrate || videoBitrate;
                if (vBitrate) videoCategory.stats.push({ label: 'Video bitrate', value: `${(vBitrate / 1000).toFixed(0)} kbps` });

                if (colormatrix) videoCategory.stats.push({ label: 'Color matrix', value: colormatrix });
                if (primaries) videoCategory.stats.push({ label: 'Primaries', value: primaries });
                if (gamma) videoCategory.stats.push({ label: 'Transfer', value: gamma });

                if (avsync != null) videoCategory.stats.push({ label: 'A/V sync', value: `${(avsync * 1000).toFixed(1)} ms` });

                if (audioCodec) audioCategory.stats.push({ label: 'Audio codec', value: audioCodec });
                const aBitrate = pktAudioBitrate || audioBitrate;
                if (aBitrate) audioCategory.stats.push({ label: 'Audio bitrate', value: `${(aBitrate / 1000).toFixed(0)} kbps` });
                if (sampleRate) audioCategory.stats.push({ label: 'Sample rate', value: `${sampleRate} Hz` });
                if (channelCount) audioCategory.stats.push({ label: 'Channels', value: `${channelCount}` });

                return { categories };
            });
        }

        getSupportedAspectRatios() {
            return [
                { id: 'auto',  name: 'Auto' },
                { id: 'cover', name: 'Cover' },
                { id: 'fill',  name: 'Fill' },
                { id: '4:3',   name: '4:3' },
                { id: '16:9',  name: '16:9' },
                { id: '21:9',  name: '21:9' },
            ].map(r => ({ ...r, selected: r.id === this._aspectRatio }));
        }

        getAspectRatio() {
            return this._aspectRatio;
        }

        setAspectRatio(value) {
            this._aspectRatio = value || 'auto';
            if (window.jmpInfo?.settings?.video) {
                window.jmpInfo.settings.video.aspect = this._aspectRatio;
            }

            // Map to mpv properties
            switch (this._aspectRatio) {
                case 'cover':
                    // panscan=1 fills the window, cropping edges
                    mpv.setProperty('video-aspect-override', '-1');
                    mpv.setProperty('panscan', '1.0');
                    break;
                case 'fill':
                    // Stretch to fill (ignore original aspect)
                    mpv.setProperty('video-aspect-override', '-1');
                    mpv.setProperty('panscan', '0.0');
                    // Use keepaspect=no for true stretch
                    mpv.setProperty('keepaspect', false);
                    break;
                case '4:3':
                    mpv.setProperty('video-aspect-override', '1.33333');
                    mpv.setProperty('panscan', '0.0');
                    mpv.setProperty('keepaspect', true);
                    break;
                case '16:9':
                    mpv.setProperty('video-aspect-override', '1.77778');
                    mpv.setProperty('panscan', '0.0');
                    mpv.setProperty('keepaspect', true);
                    break;
                case '21:9':
                    mpv.setProperty('video-aspect-override', '2.33333');
                    mpv.setProperty('panscan', '0.0');
                    mpv.setProperty('keepaspect', true);
                    break;
                default: // 'auto'
                    mpv.setProperty('video-aspect-override', '-1');
                    mpv.setProperty('panscan', '0.0');
                    mpv.setProperty('keepaspect', true);
                    break;
            }
        }
    }

    // jellyfin-web's pluginManager.loadPlugin expects window[name] to be
    // a factory function:  async () => PluginClass
    // It then does:  new PluginClass({ events, loading, ... })
    window._mpvVideoPlayer = function () { return mpvVideoPlayer; };
    trace('mpvVideoPlayer factory registered on window._mpvVideoPlayer');
    console.log('[JellyfinTauri] mpvVideoPlayer registered');
})();
