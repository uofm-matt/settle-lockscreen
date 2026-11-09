// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Setup, whyNotPlaying} from '../setup.js';
import {assertEqual} from './assert.js';

const settings = new Gio.Settings({
    schema_id: 'org.gnome.shell.extensions.settle-lockscreen',
});
const setup = new Setup(settings);
const clip = setup.videoPath;
GLib.mkdir_with_parents(setup.dataDir, 0o755);

function useWallpaper(light, dark = light) {
    for (const [key, path] of [['picture-uri', light], ['picture-uri-dark', dark]])
        setup.background.set_string(key, Gio.File.new_for_path(path).get_uri());
}

function saveState(state) {
    GLib.file_set_contents(setup.path('state.json'),
        typeof state === 'string' ? state : JSON.stringify(state));
}

// state.json beside the stop frame, and the position it should resume at
const STATES = {
    'the same clip': [{position: 12.5, clip}, 12.5],
    'another clip': [{position: 12.5, clip: '/elsewhere.mp4'}, null],
    'no clip': [{position: 12.5}, null],
    'a position that is not a number': [{position: '12.5', clip}, null],
    'half-written JSON': ['{"position": 12.5', null],
};

export const tests = {
    async 'the first frame resumes at 0'() {
        useWallpaper(setup.firstFrame);
        assertEqual(await setup.resumePosition(), 0, 'position');
    },

    async 'the stop frame resumes only from its own clip'() {
        useWallpaper(setup.stopFrame);
        for (const [what, [state, position]] of Object.entries(STATES)) {
            saveState(state);
            // eslint-disable-next-line no-await-in-loop
            assertEqual(await setup.resumePosition(), position, what);
        }
        GLib.unlink(setup.path('state.json'));
        assertEqual(await setup.resumePosition(), null, 'no state.json');
    },

    async 'a light and a dark picture that differ are not ours'() {
        useWallpaper(setup.stopFrame, setup.firstFrame);
        saveState({position: 12.5, clip});
        assertEqual(setup.ownsWallpaper(), false, 'owned');
        assertEqual(await setup.resumePosition(), null, 'position');
    },

    async 'another picture is not ours'() {
        useWallpaper('/usr/share/backgrounds/elsewhere.jpg');
        assertEqual(setup.ownsWallpaper(), false, 'owned');
        assertEqual(await setup.resumePosition(), null, 'position');
    },

    async 'a new frame becomes the stop frame, the state and the wallpaper'() {
        GLib.file_set_contents(setup.newFrame, 'frame');
        setup.useNewFrame(3.25, clip);
        assertEqual(GLib.file_test(setup.newFrame, GLib.FileTest.EXISTS),
            false, 'new frame left');
        const [, bytes] = GLib.file_get_contents(setup.stopFrame);
        assertEqual(new TextDecoder().decode(bytes), 'frame', 'stop frame');
        const uri = Gio.File.new_for_path(setup.stopFrame).get_uri();
        const keys = ['picture-uri', 'picture-uri-dark'];
        assertEqual(keys.map(key => setup.background.get_string(key)),
            [uri, uri], 'wallpaper');
        assertEqual(await setup.resumePosition(), 3.25, 'position');
    },

    async 'the state names the clip that played, not the one chosen since'() {
        GLib.file_set_contents(setup.newFrame, 'frame');
        setup.useNewFrame(4, '/played.mp4');
        const [, state] = GLib.file_get_contents(setup.path('state.json'));
        assertEqual(JSON.parse(new TextDecoder().decode(state)),
            {position: 4, clip: '/played.mp4'}, 'state');
        assertEqual(await setup.resumePosition(), null, 'another clip');
    },

    'why a video cannot play'() {
        const path = GLib.getenv('PATH');
        const bin = setup.path('bin');
        const mpv = GLib.build_filenamev([bin, 'mpv']);
        GLib.mkdir_with_parents(bin, 0o755);
        // so a host in power saver still reports ready
        settings.set_boolean('play-in-power-saver', true);
        try {
            assertEqual(whyNotPlaying(settings, clip),
                `there is no video at ${clip}`, 'no video');
            GLib.file_set_contents(clip, '');
            GLib.setenv('PATH', bin, true);
            assertEqual(whyNotPlaying(settings, clip), 'mpv is not installed',
                'no mpv');
            GLib.file_set_contents(mpv, '#!/bin/sh\n');
            GLib.chmod(mpv, 0o755);
            assertEqual(whyNotPlaying(settings, clip), null, 'ready');
        } finally {
            GLib.setenv('PATH', path, true);
        }
    },
};
