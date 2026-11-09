// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {logErrorUnlessCancelled} from 'resource:///org/gnome/shell/misc/errorUtils.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';

const DISPLAY_CONFIG = 'org.gnome.Mutter.DisplayConfig';

// Whether the display is on and the machine is not going to sleep. Mutter
// has no getter for its power-save mode, so the D-Bus property is read.
export class DisplayPower {
    constructor(onChange) {
        this._onChange = onChange;
        this._on = true;
        this._cancellable = new Gio.Cancellable();
        this._loginManager = LoginManager.getLoginManager();
        this._loginManager.connectObject('prepare-for-sleep',
            () => this._update(), this);

        this._proxy = new Gio.DBusProxy({
            g_connection: Gio.DBus.session,
            g_name: DISPLAY_CONFIG,
            g_object_path: '/org/gnome/Mutter/DisplayConfig',
            g_interface_name: DISPLAY_CONFIG,
        });
        this._proxy.connectObject('g-properties-changed',
            () => this._update(), this);
        this._proxy.init_async(GLib.PRIORITY_DEFAULT, this._cancellable)
            .then(() => this._update())
            .catch(error =>
                logErrorUnlessCancelled(error, 'Failed to watch the display'));
    }

    get on() {
        return this._on;
    }

    _update() {
        const mode = this._proxy.get_cached_property('PowerSaveMode');
        const on = !this._loginManager.preparingForSleep &&
            (!mode || mode.unpack() === 0);
        if (on === this._on)
            return;

        this._on = on;
        this._onChange();
    }

    destroy() {
        this._cancellable.cancel();
        this._loginManager.disconnectObject(this);
        this._proxy.disconnectObject(this);
    }
}
