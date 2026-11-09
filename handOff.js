// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

// The login screen's last frame, left for the session; see
// docs/login-screen.md. The .json is written last. The directory is a small
// tmpfs, so only the reads are asynchronous. No shell imports: takeFrame.js
// runs this before the shell starts.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_bytes_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async',
    'replace_contents_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const DIR = '/run/settle-lockscreen-login';
const DIR_MODE = 0o2775;
const GROUP = 'gdm';
const MAX_AGE_S = 120;
const STATE_NAME = /^([0-9a-f-]{36})\.json$/;
const SAMPLE_BYTES = 65536;
const ATTRIBUTES = 'standard::name,standard::type,owner::group,unix::uid,' +
    'unix::mode,time::modified';
const NO_SYMLINKS = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;

function child(name) {
    return Gio.File.new_for_path(DIR).get_child(name);
}

function query(file) {
    try {
        return file.query_info(ATTRIBUTES, NO_SYMLINKS, null);
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;

        throw error;
    }
}

function listDir() {
    const enumerator = Gio.File.new_for_path(DIR).enumerate_children(
        ATTRIBUTES, NO_SYMLINKS, null);
    return [...enumerator];
}

function isHandOffDir() {
    const info = query(Gio.File.new_for_path(DIR));
    return info?.get_file_type() === Gio.FileType.DIRECTORY &&
        info.get_attribute_uint32('unix::uid') === 0 &&
        info.get_attribute_string('owner::group') === GROUP &&
        (info.get_attribute_uint32('unix::mode') & 0o7777) === DIR_MODE;
}

// a regular file a greeter wrote in the last two minutes
function isFreshFrame(info) {
    const now = GLib.get_real_time() / GLib.USEC_PER_SEC;
    const age = now - info.get_attribute_uint64('time::modified');
    return info.get_file_type() === Gio.FileType.REGULAR &&
        info.get_attribute_string('owner::group') === GROUP &&
        age >= 0 && age <= MAX_AGE_S;
}

function makeReadable(path) {
    Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', 0o644,
        NO_SYMLINKS, null);
}

async function readUpTo(stream, count, cancellable) {
    const chunks = [];
    let total = 0;
    while (total < count) {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await stream.read_bytes_async(count - total,
            GLib.PRIORITY_DEFAULT, cancellable);
        if (bytes.get_size() === 0)
            break;

        chunks.push(bytes.toArray());
        total += bytes.get_size();
    }

    return chunks;
}

// The size and a hash of both ends: hashing a whole clip takes too long.
async function clipIdentity(path, cancellable) {
    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
        return null;

    const file = Gio.File.new_for_path(path);
    const size = file.query_info('standard::size',
        Gio.FileQueryInfoFlags.NONE, null).get_size();
    const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
    const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        for (const chunk of await readUpTo(stream, SAMPLE_BYTES, cancellable))
            checksum.update(chunk);
        stream.seek(Math.max(size - SAMPLE_BYTES, 0), GLib.SeekType.SET, null);
        for (const chunk of await readUpTo(stream, SAMPLE_BYTES, cancellable))
            checksum.update(chunk);
    } finally {
        stream.close(null);
    }

    return `${size}:${checksum.get_string()}`;
}

/**
 * @param {Function} screenshot saves the paused frame to the path it is given
 * @param {object} frame its position, user and clip
 * @param {Gio.Cancellable} cancellable cancelled once the frame is not wanted
 */
export async function leaveFrame(screenshot, frame, cancellable) {
    if (!isHandOffDir())
        throw new Error(`${DIR} is not set up; see docs/login-screen.md`);

    // a fresh frame may still be waiting for another seat
    for (const info of listDir()) {
        if (!isFreshFrame(info))
            child(info.get_name()).delete(null);
    }

    const base = `${DIR}/${GLib.uuid_string_random()}`;
    await screenshot(`${base}.png`);
    makeReadable(`${base}.png`);
    if (cancellable.is_cancelled())
        return;

    const state = {
        position: frame.position,
        user: frame.user,
        clip: await clipIdentity(frame.clip, cancellable),
    };
    GLib.file_set_contents(`${base}.json`, JSON.stringify(state));
    makeReadable(`${base}.json`);
}

async function readState(info, cancellable) {
    const [, stamp] = STATE_NAME.exec(info.get_name());
    try {
        const [bytes] = await child(info.get_name())
            .load_contents_async(cancellable);
        const {position, user, clip} =
            JSON.parse(new TextDecoder().decode(bytes));
        const time = info.get_attribute_uint64('time::modified');
        return {stamp, position, user, clip, time};
    } catch {
        // half-written or not ours: skip it
        return null;
    }
}

// The newest recent frame of that clip for that user, or null.
async function findFrame(user, clip, cancellable) {
    if (!isHandOffDir())
        return null;

    const states = await Promise.all(listDir()
        .filter(info => STATE_NAME.test(info.get_name()) && isFreshFrame(info))
        .map(info => readState(info, cancellable)));
    const [found] = states
        .filter(state => state?.user === user &&
            Number.isFinite(state.position))
        .sort((a, b) => b.time - a.time);
    if (!found)
        return null;

    const frame = child(`${found.stamp}.png`);
    const info = query(frame);
    if (!info || !isFreshFrame(info))
        return null;

    // last, and only when there is a frame: the clip may be large or remote
    if (found.clip !== await clipIdentity(clip, cancellable))
        return null;

    return {stamp: found.stamp, position: found.position, frame};
}

/**
 * At login, the login screen's frame becomes the wallpaper, if the wallpaper
 * is already the extension's.
 *
 * @param {object} setup the user's Setup
 * @param {Gio.Cancellable} cancellable cancelled once the frame is not wanted
 */
export async function takeFrame(setup, cancellable) {
    if (!setup.ownsWallpaper())
        return;

    const wallpaper = setup.wallpaper;
    const clip = setup.videoPath;
    const found = await findFrame(GLib.get_user_name(), clip, cancellable);
    if (!found)
        return;

    const stamp = Gio.File.new_for_path(setup.path('login-frame-stamp'));
    if (stamp.query_exists(null)) {
        const [seen] = await stamp.load_contents_async(cancellable);
        if (new TextDecoder().decode(seen) === found.stamp)
            return;
    }

    const [bytes] = await found.frame.load_bytes_async(cancellable);
    GLib.mkdir_with_parents(setup.dataDir, 0o755);
    await Gio.File.new_for_path(setup.newFrame)
        .replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
    // the user may have chosen another wallpaper meanwhile
    if (setup.wallpaper !== wallpaper) {
        GLib.unlink(setup.newFrame);
        return;
    }

    setup.useNewFrame(found.position, clip);
    GLib.file_set_contents(stamp.get_path(), found.stamp);
}
