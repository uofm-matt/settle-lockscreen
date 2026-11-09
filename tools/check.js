// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

// Run by tools/check.sh: every Gio._promisify names methods that exist, and
// the code and each schema name the same settings keys. Settings objects
// whose names contain "login" hold the login schema.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const NAMESPACES = {Gio, GLib, Gtk};
const PROMISIFY =
    /Gio\._promisify\(\s*(\w+)\.(\w+)\.prototype,\s*'(\w+)'(?:,\s*'(\w+)')?/g;
const KEY_USES = [
    /(\w*[sS]ettings)\.(?:get_\w+|set_\w+|bind|reset)\(\s*'([\w-]+)'/g,
    /Row\((settings),\s*'([\w-]+)'/g,
];
const SCHEMA = /<schema id="([\w.-]+)"[\s\S]*?<\/schema>/g;
const SCHEMA_KEY = /<key name="([\w-]+)"/g;
const MAIN = 'org.gnome.shell.extensions.settle-lockscreen';

function read(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

function list(dir, suffix) {
    const enumerator = Gio.File.new_for_path(dir).enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    return [...enumerator]
        .map(info => GLib.build_filenamev([dir, info.get_name()]))
        .filter(path => path.endsWith(suffix));
}

const code = list('.', '.js').map(read).join('\n');
const problems = [];

const promisified = [...code.matchAll(PROMISIFY)];
for (const [, namespace, type, method, finish] of promisified) {
    const proto = NAMESPACES[namespace]?.[type]?.prototype;
    const finishName =
        finish ?? `${method.replace(/_(begin|async)$/, '')}_finish`;
    for (const name of [method, finishName]) {
        if (typeof proto?.[name] !== 'function')
            problems.push(`${namespace}.${type} has no method ${name}`);
    }
}

// schema id -> its keys, and the keys the code names in it
const declared = new Map();
for (const path of list('schemas', '.gschema.xml')) {
    for (const [schema, id] of read(path).matchAll(SCHEMA)) {
        declared.set(id,
            new Set([...schema.matchAll(SCHEMA_KEY)].map(match => match[1])));
    }
}
const named = new Map([...declared.keys()].map(id => [id, new Set()]));
for (const pattern of KEY_USES) {
    for (const [, owner, key] of code.matchAll(pattern))
        named.get(/login/i.test(owner) ? `${MAIN}.login` : MAIN).add(key);
}
let keyCount = 0;
for (const [id, keys] of declared) {
    keyCount += keys.size;
    for (const key of named.get(id)) {
        if (!keys.has(key))
            problems.push(`the code reads ${key} from ${id}, which lacks it`);
    }
    for (const key of keys) {
        if (!named.get(id).has(key))
            problems.push(`no code names ${key} of ${id}`);
    }
}

problems.forEach(problem => printerr(problem));
print(`${promisified.length} promisified methods and ${keyCount} keys checked`);
System.exit(problems.length ? 1 : 0);
