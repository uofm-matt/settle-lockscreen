// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import GLib from 'gi://GLib';

/**
 * @param {*} actual what the code gave
 * @param {*} expected what it should give; objects are compared as JSON
 * @param {string} what names the check when it fails
 */
export function assertEqual(actual, expected, what) {
    // JSON would read NaN as null, so it compares only objects
    const show = value =>
        typeof value === 'number' ? String(value) : JSON.stringify(value);
    const same = typeof expected === 'object' && expected !== null
        ? show(actual) === show(expected) : Object.is(actual, expected);
    if (!same)
        throw new Error(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

/**
 * @param {number} ms how long to wait on the main loop
 * @returns {Promise} resolved after that long
 */
export function wait(ms) {
    return new Promise(resolve => {
        GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ms, resolve);
    });
}
