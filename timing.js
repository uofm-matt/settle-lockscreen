// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class Timers {
    constructor() {
        // id -> reject of the sleep waiting on it, or null
        this._sources = new Map();
    }

    after(delay, callback) {
        const id = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, delay, () => {
            this._sources.delete(id);
            callback();
        });
        this._sources.set(id, null);
        return id;
    }

    remove(id) {
        if (!this._sources.has(id))
            return;

        GLib.source_remove(id);
        this._sources.get(id)?.(new GLib.Error(Gio.IOErrorEnum,
            Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled'));
        this._sources.delete(id);
    }

    // Rejects when the timer is removed or the cancellable is cancelled.
    sleep(delay, cancellable) {
        const {promise, resolve, reject} = Promise.withResolvers();
        const id = this.after(delay, resolve);
        this._sources.set(id, reject);
        const cancelId = cancellable.connect(() => this.remove(id));
        return promise.finally(() => cancellable.disconnect(cancelId));
    }

    clear() {
        for (const id of [...this._sources.keys()])
            this.remove(id);
    }
}

// Playing time while the display is on, spent once across pauses.
export class Budget {
    constructor(allowance, onSpent) {
        this._left = allowance;
        this._onSpent = onSpent;
        this._id = 0;
        this._started = 0;
    }

    run() {
        this.pause();
        this._started = GLib.get_monotonic_time();
        const left = Math.max(this._left, 0);
        this._id = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, left, () => {
            this._id = 0;
            this._onSpent();
        });
    }

    pause() {
        if (!this._id)
            return;

        GLib.source_remove(this._id);
        this._id = 0;
        this._left -= (GLib.get_monotonic_time() - this._started) / 1000;
    }
}
