// ============================================================================
// Jellyfin Desktop — MPV Audio Player Plugin (Tauri + tauri-plugin-libmpv)
// Ported from jellyfin-desktop 2.0.0 native/mpvAudioPlayer.js
// Shares the __mpvManager instance created by mpvVideoPlayer.js
// ============================================================================
(function () {
    'use strict';

    // Only activate on jellyfin-web pages
    if (!window.location.pathname.includes('/web')) return;
    if (window._mpvAudioPlayer) return;

    // Wait for mpvManager from mpvVideoPlayer.js
    const mpv = window.__mpvManager;
    if (!mpv) {
        console.error('[MPV Audio] __mpvManager not found — mpvVideoPlayer.js must load first');
        return;
    }

    // ========================================================================
    // Fade helper
    // ========================================================================
    let fadeTimeout;

    function fade(instance, startingVolume) {
        instance._isFadingOut = true;
        const newVolume = Math.max(0, startingVolume - 15);
        console.debug('[MPV Audio] fading volume to ' + newVolume);
        mpv.setProperty('volume', newVolume);

        if (newVolume <= 0) {
            instance._isFadingOut = false;
            return Promise.resolve();
        }

        return new Promise(function (resolve, reject) {
            cancelFadeTimeout();
            fadeTimeout = setTimeout(function () {
                fade(instance, newVolume).then(resolve, reject);
            }, 100);
        });
    }

    function cancelFadeTimeout() {
        const timeout = fadeTimeout;
        if (timeout) {
            clearTimeout(timeout);
            fadeTimeout = null;
        }
    }

    // ========================================================================
    // mpvAudioPlayer class — jellyfin-web player plugin interface
    // ========================================================================
    class mpvAudioPlayer {
        constructor({ events, appHost, appSettings, toast }) {
            const self = this;

            self.events = events;
            self.appHost = appHost;
            self.appSettings = appSettings;
            self._toast = toast;

            self.name = 'MPV Audio Player';
            self.type = 'mediaplayer';
            self.id = 'mpvaudioplayer';
            self.syncPlayWrapAs = 'htmlaudioplayer';
            self.useServerPlaybackInfoForAudio = true;

            self._duration = undefined;
            self._currentTime = undefined;
            self._paused = false;
            self._volume = self.getSavedVolume() * 100;
            self._playRate = 1;
            self._hasConnection = false;
            self._isFadingOut = false;
            self._currentSrc = undefined;
            self._started = false;
            self._timeUpdated = false;
            self._currentPlayOptions = undefined;

            // ================================================================
            // MPV event handler
            // ================================================================
            self._mpvEventHandler = (mpvEvent) => {
                if (mpvEvent.event === 'property-change') {
                    switch (mpvEvent.name) {
                        case 'time-pos':
                            if (mpvEvent.data != null && !self._isFadingOut) {
                                self._currentTime = mpvEvent.data * 1000;
                                self.events.trigger(self, 'timeupdate');
                            }
                            break;
                        case 'duration':
                            if (mpvEvent.data != null) {
                                self._duration = mpvEvent.data * 1000;
                            }
                            break;
                        case 'pause':
                            if (mpvEvent.data === true) {
                                self._paused = true;
                                self.events.trigger(self, 'pause');
                            } else if (mpvEvent.data === false && self._started) {
                                if (self._paused) {
                                    self._paused = false;
                                    self.events.trigger(self, 'unpause');
                                }
                                self.events.trigger(self, 'playing');
                            }
                            break;
                        case 'eof-reached':
                            if (mpvEvent.data === true) {
                                self.onEndedInternal();
                            }
                            break;
                    }
                } else if (mpvEvent.event === 'file-loaded') {
                    // File loaded — playback starting
                    if (!self._started) {
                        self._started = true;
                        const volume = self.getSavedVolume() * 100;
                        self.setVolume(volume, volume !== self._volume);
                    }
                    self.setPlaybackRate(self.getPlaybackRate());

                    if (self._paused) {
                        self._paused = false;
                        self.events.trigger(self, 'unpause');
                    }
                    self.events.trigger(self, 'playing');
                } else if (mpvEvent.event === 'end-file') {
                    if (mpvEvent.reason === 'error') {
                        const error = mpvEvent.error || 'Unknown playback error';
                        console.error(`[MPV Audio] media error: ${error}`);
                        if (self._toast) {
                            self._toast(`media error: ${error}`);
                        }
                        self.events.trigger(self, 'error', [{ type: 'mediadecodeerror' }]);
                    }
                }
            };

            // ================================================================
            // play method
            // ================================================================
            self.play = async (options) => {
                self._started = false;
                self._timeUpdated = false;
                self._currentTime = null;
                self._duration = undefined;

                if (!self._hasConnection) {
                    self._hasConnection = true;
                    mpv.on('property-change', self._mpvEventHandler);
                    mpv.on('file-loaded', self._mpvEventHandler);
                    mpv.on('end-file', self._mpvEventHandler);
                }

                return self.setCurrentSrc(options);
            };

            self.setCurrentSrc = async (options) => {
                const val = options.url;
                self._currentSrc = val;
                console.debug('[MPV Audio] playing url: ' + val);

                const startMs = (options.playerStartPositionTicks || 0) / 10000;
                self._currentPlayOptions = options;

                // Ensure MPV is initialized
                // For audio, we init normally — the video player might already have init'd
                await mpv.ensureInit(false);

                // Apply audio configuration settings (device, passthrough, channels, etc.)
                try {
                    await self._applyAudioSettings();
                } catch (e) {
                    console.warn('[MPV Audio] Failed to apply audio settings:', e);
                }

                // Set video to none for audio-only playback
                await mpv.setProperty('vid', 'no');

                // Load the file
                const loadArgs = [val];
                if (startMs > 0) {
                    loadArgs.push('replace');
                    loadArgs.push(`start=${startMs / 1000}`);
                }
                await mpv.command('loadfile', loadArgs);

                // Unpause
                await mpv.setProperty('pause', false);

                return Promise.resolve();
            };

            self.onEndedInternal = () => {
                const stopInfo = { src: self._currentSrc };
                self.events.trigger(self, 'stopped', [stopInfo]);
                self._currentTime = null;
                self._currentSrc = null;
                self._currentPlayOptions = null;
            };

            self.stop = (destroyPlayer) => {
                cancelFadeTimeout();

                const src = self._currentSrc;

                if (src) {
                    if (!destroyPlayer) {
                        self.pause();
                        self.onEndedInternal();
                        return Promise.resolve();
                    }

                    const originalVolume = self._volume;

                    return fade(self, self._volume).then(function () {
                        self.pause();
                        self.setVolume(originalVolume, false);
                        self.onEndedInternal();
                        self.destroy();
                    });
                }
                return Promise.resolve();
            };

            self.destroy = () => {
                mpv.command('stop').catch(() => {});

                self._hasConnection = false;
                mpv.off('property-change', self._mpvEventHandler);
                mpv.off('file-loaded', self._mpvEventHandler);
                mpv.off('end-file', self._mpvEventHandler);
                self._duration = undefined;
            };

            /**
             * Apply audio configuration settings (device, channels, passthrough, etc.)
             * from jmpInfo.settings.audio to the MPV instance. Called once per play().
             */
            self._applyAudioSettings = async () => {
                const audioSettings = window.jmpInfo?.settings?.audio;
                if (!audioSettings) return;

                const mgr = window.__mpvManager;

                // Exclusive mode (WASAPI exclusive on Windows)
                if (audioSettings.exclusive) {
                    await mgr.setProperty('audio-exclusive', 'yes');
                } else {
                    await mgr.setProperty('audio-exclusive', 'no');
                }

                // Normalize downmix volume
                if (audioSettings.normalize) {
                    await mgr.setProperty('audio-normalize-downmix', 'yes');
                    await mgr.setProperty('audio-swresample-o', 'surround_mix_level=1');
                } else {
                    await mgr.setProperty('audio-normalize-downmix', 'no');
                }

                // Passthrough — build comma-separated codec list for audio-spdif
                const passthrough = [];
                if (audioSettings.passthrough_ac3)    passthrough.push('ac3');
                if (audioSettings.passthrough_dts)    passthrough.push('dts');
                if (audioSettings.passthrough_eac3)   passthrough.push('eac3');
                if (audioSettings.passthrough_dtshd)  passthrough.push('dts-hd');
                if (audioSettings.passthrough_truehd) passthrough.push('truehd');
                if (passthrough.length > 0) {
                    await mgr.setProperty('audio-spdif', passthrough.join(','));
                } else {
                    await mgr.setProperty('audio-spdif', '');
                }

                // Audio channels
                const channelMap = { 'auto': 'auto', '2.0': 'stereo', '5.1': '5.1', '7.1': '7.1' };
                const channels = channelMap[audioSettings.channels] || 'auto';
                if (passthrough.length > 0 && audioSettings.channels === 'auto') {
                    await mgr.setProperty('audio-channels', 'stereo');
                } else {
                    await mgr.setProperty('audio-channels', channels);
                }

                // Audio device
                if (audioSettings.device && audioSettings.device !== 'auto') {
                    await mgr.setProperty('audio-device', audioSettings.device);
                }

                console.log('[MPV Audio] Audio settings applied');
            };
        }

        getSavedVolume() {
            return this.appSettings.get('volume') || 1;
        }

        currentSrc() {
            return this._currentSrc;
        }

        canPlayMediaType(mediaType) {
            return (mediaType || '').toLowerCase() === 'audio';
        }

        getDeviceProfile(item, options) {
            if (this.appHost.getDeviceProfile) {
                return this.appHost.getDeviceProfile(item, options);
            }
            return {};
        }

        currentTime(val) {
            if (val != null) {
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

        seekable() {
            return Boolean(this._duration);
        }

        getBufferedRanges() {
            return [];
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
            this._playRate = value;
            mpv.setProperty('speed', +value);
        }

        getPlaybackRate() {
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
            ];
        }

        saveVolume(value) {
            if (value) {
                this.appSettings.set('volume', value);
            }
        }

        setVolume(val, save = true) {
            this._volume = val;
            if (save) {
                this.saveVolume((val || 100) / 100);
                this.events.trigger(this, 'volumechange');
            }
            mpv.setProperty('volume', val);
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

        supports(feature) {
            const supportedFeatures = ['PlaybackRate'];
            return supportedFeatures.indexOf(feature) !== -1;
        }
    }

    // jellyfin-web's pluginManager.loadPlugin expects window[name] to be
    // a factory function:  async () => PluginClass
    window._mpvAudioPlayer = function () { return mpvAudioPlayer; };
    console.log('[JellyfinTauri] mpvAudioPlayer registered');
})();
