// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {logErrorUnlessCancelled} from 'resource:///org/gnome/shell/misc/errorUtils.js';

import {DisplayPower} from './display.js';
import {Setup, whyNotPlaying} from './setup.js';
import {Timers} from './timing.js';
import {Video} from './video.js';

const FADE_IN_MS = 600;
const FADE_OUT_MS = 400;
const SWAP_CEILING_MS = 3000;

const State = {
    IDLE: 'idle',
    STARTING: 'starting',
    PLAYING: 'playing',
    SETTLING: 'settling',
};

export class LockScreen {
    constructor(settings) {
        this._settings = settings;
        this._setup = new Setup(settings);
        this._state = State.IDLE;
        this._timers = new Timers();
        this._cancellable = new Gio.Cancellable();
        this._startId = 0;
        this._video = null;
        this._settling = null;
        this._playedThisLock = false;

        // Hack: wallpaper actors made while the video plays need a layer too
        const lockScreen = this;
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(
            Background.BackgroundManager.prototype, '_createBackgroundActor',
            originalMethod => {
                /* eslint-disable no-invalid-this */
                return function (...args) {
                    const actor = originalMethod.call(this, ...args);
                    if (lockScreen._video?.isReady)
                        lockScreen._addLayer(actor);
                    return actor;
                };
                /* eslint-enable no-invalid-this */
            });

        Main.screenShield.connectObject('locked-changed',
            () => this._onLockedChanged(), this);
        this._power = new DisplayPower(() => this._onDisplayPower());
        if (Main.screenShield.locked)
            this._onLockedChanged();
    }

    // A playing video is dropped: only a settle saves its position.
    destroy() {
        this._cancellable.cancel();
        this._timers.clear();
        this._stop();

        this._injectionManager.clear();
        this._injectionManager = null;

        Main.screenShield.disconnectObject(this);
        this._power.destroy();
        this._power = null;

        this._settings = null;
        this._setup = null;
    }

    _onLockedChanged() {
        if (Main.screenShield.locked) {
            this._playedThisLock = false;
            if (this._state === State.SETTLING)
                this._resume();
            else if (this._state === State.IDLE)
                this._scheduleStart();
        } else if (this._state === State.PLAYING) {
            this._settle(this._settings.get_int('settle-delay-ms'));
        } else if (this._state === State.STARTING) {
            this._stop();
        }
    }

    _onDisplayPower() {
        if (!Main.screenShield.locked)
            return;

        if (this._state === State.PLAYING)
            this._video.setPlaying(this._power.on);
        else if (this._state === State.IDLE && !this._playedThisLock)
            this._scheduleStart();
    }

    // Hack: at a lock the shell rebuilds this class once for each earlier
    // extension it disables, all in one turn, so the start waits for the next.
    _scheduleStart() {
        this._timers.remove(this._startId);
        this._startId = this._timers.after(0, () => {
            this._startId = 0;
            this._start().catch(error => {
                if (logErrorUnlessCancelled(error, 'Failed to play'))
                    this._stop();
            });
        });
    }

    async _start() {
        const setup = this._setup;
        const wallpaper = setup.wallpaper;
        const position = await setup.resumePosition(this._cancellable);
        // the wallpaper may have changed during the read
        if (position === null || setup.wallpaper !== wallpaper)
            return;

        if (this._state !== State.IDLE || !Main.screenShield.locked ||
            this._playedThisLock || !this._power.on ||
            whyNotPlaying(this._settings, setup.videoPath))
            return;

        this._state = State.STARTING;
        this._playedThisLock = true;
        const focused = global.display.focus_window;
        const video = new Video(this._settings, setup.videoPath, {
            onGone: () => {
                if (video !== this._video)
                    return;

                console.error('mpv went away');
                this._stop();
            },
            onSpent: () => {
                if (this._state === State.PLAYING)
                    this._settle(0);
            },
        });
        this._video = video;
        await video.start(position);

        // Hack: wallpaper actors are reachable only through their managers
        const managers = [
            ...Main.layoutManager._bgManagers,
            ...Main.screenShield._dialog._bgManagers,
        ];
        for (const manager of managers)
            this._addLayer(manager.backgroundActor);

        this._state = State.PLAYING;
        video.show(FADE_IN_MS);
        // Hack: mapping mpv's window took the focus from the app that had it
        if (focused && global.display.list_all_windows().includes(focused))
            focused.focus(global.display.get_current_time_roundtrip());

        await this._timers.sleep(FADE_IN_MS, this._cancellable);
        if (video === this._video && this._state === State.PLAYING)
            video.setPlaying(this._power.on);
    }

    // Locked again during a settle: play on.
    _resume() {
        this._settling.cancel();
        this._state = State.PLAYING;
        this._playedThisLock = true;
        this._video.fade(255, FADE_IN_MS);
        this._video.resume(this._power.on);
    }

    async _settle(delay) {
        const setup = this._setup;
        const video = this._video;
        const wallpaper = setup.wallpaper;
        const settling = new Gio.Cancellable();
        this._settling = settling;
        this._state = State.SETTLING;

        try {
            const ramp = this._settings.get_int('settle-ramp-ms');
            const position = await video.slowToStop(delay, ramp, settling);
            if (settling.is_cancelled())
                return;

            GLib.mkdir_with_parents(setup.dataDir, 0o755);
            await video.screenshot(setup.newFrame);
            if (settling.is_cancelled())
                return;

            // the user chose another wallpaper during the slow-down
            if (!setup.ownsWallpaper() || setup.wallpaper !== wallpaper) {
                this._stop();
                GLib.unlink(setup.newFrame);
                return;
            }

            // Hack: only the managers report the swap
            const swapped = Main.layoutManager._bgManagers.map(
                manager => this._waitChanged(manager, settling));
            setup.useNewFrame(position, video.path);

            // hold the paused video until the same frame is underneath
            await Promise.race([
                Promise.all(swapped),
                this._timers.sleep(SWAP_CEILING_MS, settling),
            ]);
            if (settling.is_cancelled())
                return;

            video.fade(0, FADE_OUT_MS);
            await this._timers.sleep(FADE_OUT_MS, settling);
            if (!settling.is_cancelled())
                this._stop();
        } catch (error) {
            if (!settling.is_cancelled()) {
                console.error('Failed to settle:', error);
                this._stop();
            }
        }
    }

    _waitChanged(manager, cancellable) {
        const {promise, resolve, reject} = Promise.withResolvers();
        let cancelId = 0;
        manager.connectObject('changed', () => {
            manager.disconnectObject(this);
            cancellable.disconnect(cancelId);
            resolve();
        }, this);
        cancelId = cancellable.connect(() => {
            manager.disconnectObject(this);
            reject(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED,
                'Settling was cancelled'));
        });
        return promise;
    }

    _addLayer(backgroundActor) {
        const monitor = Main.layoutManager.monitors[backgroundActor.monitor];
        backgroundActor.add_child(this._video.addLayer(monitor));
    }

    _stop() {
        this._settling?.cancel();
        this._video?.stop();
        this._video = null;
        this._settling = null;
        this._state = State.IDLE;
    }
}
