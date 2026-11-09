// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

// Run as the user by settle-lockscreen-login.service before the shell starts,
// so the session's first picture is the login screen's last frame.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {takeFrame} from './handOff.js';
import {Setup} from './setup.js';

const UUID = 'settle-lockscreen@uofm-matt.github.io';
const SCHEMA = 'org.gnome.shell.extensions.settle-lockscreen';

// enabled as the shell decides it, in extensionSystem.js
const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
if (shell.get_boolean('disable-user-extensions') ||
    !shell.get_strv('enabled-extensions').includes(UUID) ||
    shell.get_strv('disabled-extensions').includes(UUID))
    System.exit(0);

// the schema beside this file, else installed system-wide, as the shell does
const schemas = Gio.File.new_for_uri(import.meta.url).get_parent()
    .get_child('schemas');
const source = schemas.query_exists(null)
    ? Gio.SettingsSchemaSource.new_from_directory(schemas.get_path(),
        Gio.SettingsSchemaSource.get_default(), false)
    : Gio.SettingsSchemaSource.get_default();
const settings = new Gio.Settings({
    settings_schema: source.lookup(SCHEMA, true),
});

const loop = new GLib.MainLoop(null, false);
let status = 0;
takeFrame(new Setup(settings), null).catch(error => {
    printerr(`Failed to take the login frame: ${error.message}`);
    status = 1;
}).finally(() => loop.quit());
loop.run();
// the wallpaper reaches dconf before the shell reads it
Gio.Settings.sync();
System.exit(status);
