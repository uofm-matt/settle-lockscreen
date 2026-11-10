// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {logErrorUnlessCancelled} from 'resource:///org/gnome/shell/misc/errorUtils.js';

import {Greeter} from './greeter.js';
import {takeFrame} from './handOff.js';
import {LockScreen} from './lockScreen.js';
import {Setup} from './setup.js';

const LOGIN_SCHEMA = 'org.gnome.shell.extensions.settle-lockscreen.login';

// At login the session shows the login screen's last frame at once: the
// frame is taken, unless takeFrame.js took it before the shell started, and
// if the wallpaper is the extension's, the startup animation does not run.
class LoginFrame {
    constructor(settings) {
        this._cancellable = new Gio.Cancellable();
        this._startupId = 0;
        // a rebuild at a lock is not a login
        if (Main.sessionMode.isLocked)
            return;

        const setup = new Setup(settings);
        // Hack: the startup state is private
        if (Main.layoutManager._startingUp && setup.ownsWallpaper()) {
            St.Settings.get().inhibit_animations();
            this._startupId = Main.layoutManager.connect('startup-complete',
                () => this._endStartup());
        }
        takeFrame(setup, this._cancellable).catch(error =>
            logErrorUnlessCancelled(error, 'Failed to take the login frame'));
    }

    _endStartup() {
        if (!this._startupId)
            return;

        Main.layoutManager.disconnect(this._startupId);
        this._startupId = 0;
        St.Settings.get().uninhibit_animations();
    }

    destroy() {
        this._cancellable.cancel();
        this._endStartup();
    }
}

// The system install: the lock screen of extension.js, plus the login screen
// and the frame it leaves for the session; see docs/login-screen.md.
export default class SettleLockscreenExtension extends Extension {
    enable() {
        this._parts = [];
        // without GDM the shell has no lock screen, see main.js
        if (!Main.screenShield)
            return;

        const settings = this.getSettings();
        if (Main.sessionMode.isGreeter) {
            const login = this.getSettings(LOGIN_SCHEMA);
            this._parts.push(new Greeter(settings, login));
        } else {
            this._parts.push(new LockScreen(settings));
            this._parts.push(new LoginFrame(settings));
        }
    }

    // The video plays behind the lock screen and slows to a stop after the
    // unlock, so the extension runs in user as well; it connects no keyboard
    // signals. A disable during a lock drops the video, and the next enable
    // starts it again from the wallpaper's frame, still in unlock-dialog.
    disable() {
        for (const part of this._parts)
            part.destroy();
        this._parts = [];
    }
}
