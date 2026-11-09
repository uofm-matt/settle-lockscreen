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

    // The video plays behind the lock screen, so the extension keeps running
    // in unlock-dialog; it connects no keyboard signals.
    disable() {
        this._lockScreen?.destroy();
        this._lockScreen = null;
    }
}
