// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

// Run by tools/check.sh, which sets up a scratch data dir and settings.

import GLib from 'gi://GLib';
import System from 'system';

import {wait} from './assert.js';
import * as setup from './setup.test.js';
import * as timing from './timing.test.js';

const TIMEOUT_MS = 10000;

async function run() {
    let failed = 0;
    for (const [suite, {tests}] of Object.entries({setup, timing})) {
        for (const [name, test] of Object.entries(tests)) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await Promise.race([test(), wait(TIMEOUT_MS).then(() => {
                    throw new Error('timed out');
                })]);
                print(`ok ${suite}: ${name}`);
            } catch (error) {
                failed++;
                print(`not ok ${suite}: ${name}: ${error.message}`);
            }
        }
    }
    return failed;
}

const loop = new GLib.MainLoop(null, false);
let failed = 1;
run().then(count => {
    failed = count;
}).catch(error => printerr(error)).finally(() => loop.quit());
loop.run();
System.exit(failed ? 1 : 0);
