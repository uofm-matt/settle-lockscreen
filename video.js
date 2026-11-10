// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createCover} from './cover.js';
import {Player} from './player.js';
import {Budget, Timers} from './timing.js';

const WINDOW_TIMEOUT_MS = 10000;

// One playback: mpv, its window, the layers showing it and its play budget.
export class Video {
    constructor(settings, path, {onGone, onSpent}) {
        this.path = path;
        this._settings = settings;
        this._onSpent = onSpent;
        this._timers = new Timers();
        this._layers = new Set();
        this._shown = false;
        this._budget = this._newBudget();
        this._adoption = null;
        this._windowTimeoutId = 0;
        this._size = null;
        this._window = null;
        this._actor = null;

        this._player = new Player({
            path,
            hardwareDecoding: settings.get_boolean('hardware-decoding'),
            onWindow: window => this._adopt(window),
            onGone,
        });
    }

    get layers() {
        return this._layers;
    }

    get isReady() {
        return Boolean(this._size && this._actor);
    }

    _adopt(window) {
        this._timers.remove(this._windowTimeoutId);
        const actor = window.get_compositor_private();
        if (!actor) {
            this._adoption.reject(new Error('mpv window has no actor'));
            return;
        }

        actor.opacity = 0;
        window.hide_from_window_list();
        this._window = window;
        this._actor = actor;
        this._adoption.resolve();
    }

    // Resolves once mpv has decoded a frame and its window is ours.
    async start(position) {
        this._adoption = Promise.withResolvers();
        this._windowTimeoutId = this._timers.after(WINDOW_TIMEOUT_MS,
            () => this._adoption.reject(new Error('mpv showed no window')));
        [this._size] = await Promise.all(
            [this._player.start(position), this._adoption.promise]);
    }

    addLayer(monitor) {
        const layer = createCover(monitor, this._actor, this._size);
        layer.opacity = this._shown ? 255 : 0;

        // the shell destroys the parent, and the layer with it
        layer.connectObject('destroy',
            () => this._layers.delete(layer), this);
        this._layers.add(layer);
        return layer;
    }

    clearLayers() {
        for (const layer of this._layers)
            layer.destroy();
    }

    // mpv's first frame is the picture underneath, so the fade shows nothing.
    show(duration) {
        // unmap only after mpv has drawn, or the clones get no frame
        this._window.inhibit_mapped();
        this.fade(255, duration);
    }

    fade(opacity, duration) {
        this._shown = opacity > 0;
        for (const layer of this._layers) {
            layer.ease({
                opacity,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    setPlaying(playing) {
        if (playing)
            this._budget.run();
        else
            this._budget.pause();

        this._player.tell('pause', !playing);
    }

    // Back to full speed after a slow-down, with a new allowance.
    resume(displayOn) {
        this._budget.pause();
        this._budget = this._newBudget();
        this._player.tell('speed', 1);
        this.setPlaying(displayOn);
    }

    slowToStop(delay, ramp, cancellable) {
        this._budget.pause();
        return this._player.slowToStop(delay, ramp, cancellable);
    }

    screenshot(path) {
        return this._player.command('screenshot-to-file', path, 'video');
    }

    _newBudget() {
        const allowance = this._settings.get_int('lock-play-seconds') * 1000;
        return new Budget(allowance, this._onSpent);
    }

    stop() {
        this._timers.clear();
        this._adoption.reject(new GLib.Error(Gio.IOErrorEnum,
            Gio.IOErrorEnum.CANCELLED, 'Video stopped'));
        this._budget.pause();
        this.clearLayers();
        this._player.stop();
    }
}
