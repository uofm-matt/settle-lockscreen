// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const FIRST_FRAME = 'first-frame.jpg';
const STOP_FRAME = 'stop-frame.png';
const NEW_FRAME = 'new-frame.png';

// The shell has a lock screen only when GDM answers this, as in canLock() in
// the shell's misc/loginManager.js.
async function haveGdm() {
    try {
        await Gio.DBus.system.call('org.gnome.DisplayManager',
            '/org/gnome/DisplayManager/Manager',
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)',
                ['org.gnome.DisplayManager.Manager', 'Version']),
            null, Gio.DBusCallFlags.NONE, -1, null);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {Gio.Settings} settings the extension's settings
 * @param {string} path the video
 * @returns {string|null} why that video cannot play now, or null
 */
export function whyNotPlaying(settings, path) {
    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
        return `there is no video at ${path}`;

    if (!GLib.find_program_in_path('mpv'))
        return 'mpv is not installed';

    const monitor = Gio.PowerProfileMonitor.dup_default();
    if (monitor.power_saver_enabled &&
        !settings.get_boolean('play-in-power-saver'))
        return 'power saver is on';
    return null;
}

// The user's setup and the extension's files; no shell imports, for prefs.
export class Setup {
    constructor(settings) {
        this._settings = settings;
        this.background = new Gio.Settings({
            schema_id: 'org.gnome.desktop.background',
        });
        this.dataDir = GLib.build_filenamev(
            [GLib.get_user_data_dir(), 'settle-lockscreen']);
    }

    path(name) {
        return GLib.build_filenamev([this.dataDir, name]);
    }

    get firstFrame() {
        return this.path(FIRST_FRAME);
    }

    get stopFrame() {
        return this.path(STOP_FRAME);
    }

    get newFrame() {
        return this.path(NEW_FRAME);
    }

    get videoPath() {
        return this._settings.get_string('video-path') ||
            this.path('clip.mp4');
    }

    // the picture the light and the dark wallpaper share, or null
    get wallpaper() {
        const [light, dark] = ['picture-uri', 'picture-uri-dark'].map(key => {
            const uri = this.background.get_string(key);
            return uri ? Gio.File.new_for_uri(uri).get_path() : null;
        });
        return light === dark ? light : null;
    }

    ownsWallpaper() {
        const path = this.wallpaper;
        return path === this.firstFrame || path === this.stopFrame;
    }

    // Where to resume, or null unless the wallpaper came from this video.
    async resumePosition(cancellable = null) {
        const path = this.wallpaper;
        if (path === this.firstFrame)
            return 0;

        if (path !== this.stopFrame)
            return null;

        let state;
        try {
            const [bytes] = await Gio.File.new_for_path(this.path('state.json'))
                .load_contents_async(cancellable);
            state = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }

        return state.clip === this.videoPath && Number.isFinite(state.position)
            ? state.position
            : null;
    }

    async whyIdle() {
        if (!await haveGdm())
            return 'without GDM, GNOME Shell has no lock screen';

        const why = whyNotPlaying(this._settings, this.videoPath);
        if (why)
            return why;

        if (await this.resumePosition() === null) {
            return 'the wallpaper, light and dark, is neither ' +
                `${this.firstFrame} nor this video's last stop`;
        }
        return null;
    }

    setWallpaper(path) {
        const uri = Gio.File.new_for_path(path).get_uri();
        this.background.set_string('picture-uri', uri);
        this.background.set_string('picture-uri-dark', uri);
    }

    // The new frame becomes the stop frame and the wallpaper. The clip is the
    // one that played, since the setting may have changed since.
    useNewFrame(position, clip) {
        Gio.File.new_for_path(this.newFrame).move(
            Gio.File.new_for_path(this.stopFrame),
            Gio.FileCopyFlags.OVERWRITE, null, null);
        GLib.file_set_contents(this.path('state.json'),
            JSON.stringify({position, clip}));
        this.setWallpaper(this.stopFrame);
    }
}
