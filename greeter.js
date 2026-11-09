// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LoginDialog} from 'resource:///org/gnome/shell/gdm/loginDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ScreenShield from 'resource:///org/gnome/shell/ui/screenShield.js';
import {logErrorUnlessCancelled} from 'resource:///org/gnome/shell/misc/errorUtils.js';

import {DisplayPower} from './display.js';
import {leaveFrame} from './handOff.js';
import {whyNotPlaying} from './setup.js';
import {Timers} from './timing.js';
import {Video} from './video.js';

// the greeter user cannot read anyone's home
const SYSTEM_CLIP = '/usr/local/share/settle-lockscreen/clip.mp4';
const FADE_IN_MS = 600;
const FADE_OUT_MS = 400;
// time for the screenshot and mpv's replies, after which the session starts
const LEAVE_SLACK_MS = 2000;
// GNOME 50 calls the _sync one, GNOME 51 the promisified one
const START_CALLS = [
    'call_start_session_when_ready',
    'call_start_session_when_ready_sync',
];

const State = {
    IDLE: 'idle',
    STARTING: 'starting',
    PLAYING: 'playing',
    FADING: 'fading',
    LEAVING: 'leaving',
};

// The login screen; see docs/login-screen.md.
export class Greeter {
    constructor(settings, loginSettings) {
        this._settings = settings;
        this._loginSettings = loginSettings;
        this._clip = settings.get_string('video-path') || SYSTEM_CLIP;
        this._state = State.IDLE;
        this._timers = new Timers();
        this._injectionManager = new InjectionManager();
        this._dialog = null;
        this._video = null;
        this._heldClient = null;
        this._pendingStart = null;
        this._limitId = 0;
        this._watched = null;
        this._restackId = 0;

        this._power = new DisplayPower(() => this._onDisplayPower());
        Main.layoutManager.connectObject('monitors-changed',
            () => this._rebuild(), this);

        // Hack: the shield builds the dialog late, and again after a destroy
        const greeter = this;
        this._injectionManager.overrideMethod(
            ScreenShield.ScreenShield.prototype, '_ensureUnlockDialog',
            originalMethod => {
                /* eslint-disable no-invalid-this */
                return function (...args) {
                    const result = originalMethod.call(this, ...args);
                    if (this._dialog)
                        greeter._useDialog(this._dialog);
                    return result;
                };
                /* eslint-enable no-invalid-this */
            });
        // Hack: GDM leaves once the session starts, so the start is held
        this._injectionManager.overrideMethod(
            LoginDialog.prototype, '_startSession',
            originalMethod => {
                /* eslint-disable no-invalid-this */
                return function (...args) {
                    greeter._holdStart(this);
                    return originalMethod.call(this, ...args);
                };
                /* eslint-enable no-invalid-this */
            });
        // Hack: the login dialog is reachable only through the shield
        if (Main.screenShield._dialog)
            this._useDialog(Main.screenShield._dialog);
    }

    destroy() {
        // a held session start goes ahead now
        this._pendingStart?.();
        this._injectionManager.clear();
        this._injectionManager = null;

        this._timers.clear();
        this._stop();

        this._dialog?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._power.destroy();
        this._power = null;
        this._settings = null;
        this._loginSettings = null;
    }

    _useDialog(dialog) {
        if (dialog === this._dialog)
            return;

        this._dialog?.disconnectObject(this);
        this._dialog = dialog;
        dialog.connectObject('destroy', () => {
            this._dialog = null;
            this._stop();
        }, this);
        this._play();
    }

    _onDisplayPower() {
        if (this._state === State.PLAYING)
            this._video.setPlaying(this._power.on);
        else if (this._state === State.IDLE && this._power.on && this._dialog)
            this._play();
    }

    _play() {
        this._start().catch(error => {
            if (logErrorUnlessCancelled(error, 'Failed to play'))
                this._stop();
        });
    }

    async _start() {
        if (this._state !== State.IDLE || !this._power.on ||
            whyNotPlaying(this._settings, this._clip))
            return;

        this._state = State.STARTING;
        const video = new Video(this._settings, this._clip, {
            onGone: () => {
                if (video !== this._video)
                    return;

                console.error('mpv went away');
                this._stop();
            },
            onSpent: () => this._fadeOut(),
        });
        this._video = video;
        await video.start(0);

        this._rebuild();
        this._state = State.PLAYING;
        video.show(FADE_IN_MS);
        video.setPlaying(this._power.on);
    }

    _fadeOut() {
        this._state = State.FADING;
        this._video.fade(0, FADE_OUT_MS);
        this._timers.after(FADE_OUT_MS, () => {
            if (this._state === State.FADING)
                this._stop();
        });
    }

    // Overrides the client's start calls until one of them is made.
    _holdStart(dialog) {
        // Hack: the dialog's private Gdm client
        const client = dialog._greeter;
        if (!client || this._heldClient || this._state !== State.PLAYING ||
            !this._power.on || !this._loginSettings.get_boolean('settle'))
            return;

        this._heldClient = client;
        for (const name of START_CALLS) {
            this._injectionManager.overrideMethod(client, name,
                originalMethod => (...args) => {
                    this._releaseClient();
                    const start = () => originalMethod.apply(client, args);
                    // the video may have stopped since the password was taken
                    if (this._state !== State.PLAYING || !this._power.on)
                        return start();

                    const started = this._deferStart(start);
                    if (!name.endsWith('_sync'))
                        return started;

                    started.catch(error =>
                        console.error('Failed to start the session:', error));
                    return true;
                });
        }
    }

    _releaseClient() {
        for (const name of START_CALLS)
            this._injectionManager.restoreMethod(this._heldClient, name);
        this._heldClient = null;
    }

    // Makes the call once the video has stopped, or when its time is up.
    _deferStart(call) {
        const handOff = new Gio.Cancellable();
        const {promise, resolve} = Promise.withResolvers();
        const startNow = () => {
            if (this._pendingStart !== startNow)
                return;

            this._pendingStart = null;
            this._timers.remove(this._limitId);
            // once the session starts, a frame would be too late
            handOff.cancel();
            resolve(Promise.try(call));
        };
        this._pendingStart = startNow;

        const limit = this._settings.get_int('settle-delay-ms') +
            this._settings.get_int('settle-ramp-ms') + LEAVE_SLACK_MS;
        this._limitId = this._timers.after(limit, startNow);

        // Hack: the dialog's selected user, on GNOME 50 and 51 alike
        const user = this._dialog._user?.get_user_name();
        this._settleAndHandOff(user, handOff)
            .catch(error =>
                logErrorUnlessCancelled(error, 'Failed to hand off the frame'))
            .finally(startNow);
        return promise;
    }

    async _settleAndHandOff(user, handOff) {
        const video = this._video;
        this._state = State.LEAVING;

        const position = await video.slowToStop(
            this._settings.get_int('settle-delay-ms'),
            this._settings.get_int('settle-ramp-ms'), handOff);
        if (handOff.is_cancelled() || !user)
            return;

        const frame = {position, user, clip: this._clip};
        await leaveFrame(path => video.screenshot(path), frame, handOff);
    }

    _rebuild() {
        if (!this._video?.isReady)
            return;

        this._video.clearLayers();
        const parent = this._dialog.get_parent();
        const alpha = Math.round(this._loginSettings.get_double('dim') * 255);
        const shade = new Cogl.Color({red: 0, green: 0, blue: 0, alpha});
        for (const monitor of Main.layoutManager.monitors) {
            const layer = this._video.addLayer(monitor);
            layer.set_position(monitor.x, monitor.y);
            if (alpha > 0) {
                layer.add_child(new Clutter.Actor({
                    width: monitor.width,
                    height: monitor.height,
                    background_color: shade,
                }));
            }

            parent.add_child(layer);
        }

        this._watch(parent);
        this._restack();
    }

    // just below the dialog: over the greeter's background, under the rest
    _restack() {
        const parent = this._dialog.get_parent();
        for (const layer of this._video.layers)
            parent.set_child_below_sibling(layer, this._dialog);
    }

    // A later child lands over the layers, so they go back under the dialog.
    _watch(parent) {
        if (this._watched)
            return;

        this._watched = parent;
        parent.connectObject(
            'child-added', (_parent, child) => {
                if (this._video.layers.has(child))
                    return;

                this._timers.remove(this._restackId);
                this._restackId = this._timers.after(0, () => this._restack());
            },
            'destroy', () => {
                this._watched = null;
            },
            this);
    }

    _stop() {
        if (this._state === State.IDLE)
            return;

        this._timers.remove(this._restackId);
        this._watched?.disconnectObject(this);
        this._watched = null;
        this._video.stop();
        this._video = null;
        this._state = State.IDLE;
    }
}
