// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LockScreen} from './lockScreen.js';

export default class SettleLockscreenExtension extends Extension {
    enable() {
        // without GDM the shell has no lock screen, see main.js
        if (Main.screenShield)
            this._lockScreen = new LockScreen(this.getSettings());
    }

    // The video plays behind the lock screen and slows to a stop after the
    // unlock, so the extension runs in user as well; it connects no keyboard
    // signals. A disable during a lock drops the video, and the next enable
    // starts it again from the wallpaper's frame, still in unlock-dialog.
    disable() {
        this._lockScreen?.destroy();
        this._lockScreen = null;
    }
}
