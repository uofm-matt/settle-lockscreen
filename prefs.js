// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Setup} from './setup.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// mpv saves the video's first frame, which becomes the wallpaper.
async function useFirstFrame(setup) {
    // mpv names the image after the frame number
    const image = setup.path('00000001.jpg');
    GLib.mkdir_with_parents(setup.dataDir, 0o755);
    GLib.unlink(image);
    const mpv = Gio.Subprocess.new([
        'mpv', '--no-config', '--no-terminal', '--no-audio', '--frames=1',
        '--vo=image', '--vo-image-format=jpg',
        `--vo-image-outdir=${setup.dataDir}`, '--', setup.videoPath,
    ], Gio.SubprocessFlags.NONE);
    await mpv.wait_check_async(null);

    Gio.File.new_for_path(image).move(
        Gio.File.new_for_path(setup.firstFrame),
        Gio.FileCopyFlags.OVERWRITE, null, null);
    setup.setWallpaper(setup.firstFrame);
}

export default class SettleLockscreenPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const setup = new Setup(settings);
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const status = new Adw.ActionRow({title: 'Status'});
        const video = new Adw.ActionRow({title: 'Video'});
        // a slow whyIdle() must not overwrite a later answer
        let latest = 0;
        const update = async () => {
            const mine = ++latest;
            video.subtitle = setup.videoPath;
            const why = await setup.whyIdle();
            if (mine === latest)
                status.subtitle = why ?? 'Ready for the next lock';
        };
        const updateLater = () => update().catch(error =>
            console.error('Failed to read the state:', error));
        updateLater();
        const settingsId = settings.connect('changed', updateLater);
        const backgroundId = setup.background.connect('changed', updateLater);
        window.connect('close-request', () => {
            settings.disconnect(settingsId);
            setup.background.disconnect(backgroundId);
        });

        const choose = new Gtk.Button({
            label: 'Choose…',
            valign: Gtk.Align.CENTER,
        });
        choose.connect('clicked', () => {
            this._chooseVideo(window, settings).catch(error =>
                console.error('Failed to choose a video:', error));
        });
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Use clip.mp4 in the data folder',
            valign: Gtk.Align.CENTER,
        });
        reset.connect('clicked', () => settings.reset('video-path'));
        video.add_suffix(choose);
        video.add_suffix(reset);

        const firstFrame = new Adw.ButtonRow({
            title: 'Make its first frame the wallpaper',
        });
        firstFrame.connect('activated', () => {
            useFirstFrame(setup).catch(error =>
                console.error('Failed to use the first frame:', error));
        });
        group.add(status);
        group.add(video);
        group.add(firstFrame);

        group.add(spinRow(settings, 'lock-play-seconds', 'Longest play',
            'Seconds at a time, while the display is on', 5, 3600, 5));
        group.add(spinRow(settings, 'settle-delay-ms', 'Moving after unlock',
            'Milliseconds before the slow-down starts', 0, 10000, 100));
        group.add(spinRow(settings, 'settle-ramp-ms', 'Slow-down',
            'Milliseconds from full speed to a stop', 200, 10000, 100));
        group.add(switchRow(settings, 'hardware-decoding',
            'Hardware decoding', 'Turn off if the video glitches'));
        group.add(switchRow(settings, 'play-in-power-saver',
            'Play in power saver', null));

        window.add(page);
    }

    async _chooseVideo(window, settings) {
        const videos = new Gtk.FileFilter({name: 'Videos'});
        videos.add_mime_type('video/*');
        const all = new Gtk.FileFilter({name: 'All files'});
        all.add_pattern('*');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(videos);
        filters.append(all);
        const dialog = new Gtk.FileDialog({
            title: 'Choose a video',
            filters,
            default_filter: videos,
        });
        let file;
        try {
            file = await dialog.open(window, null);
        } catch (error) {
            if (error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return;

            throw error;
        }

        // mpv needs a local path
        const path = file.get_path();
        if (path)
            settings.set_string('video-path', path);
    }
}
