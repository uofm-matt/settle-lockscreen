// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Budget, Timers} from '../timing.js';
import {assertEqual, wait} from './assert.js';

async function outcome(promise) {
    try {
        await promise;
        return 'resolved';
    } catch (error) {
        return error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
            ? 'cancelled' : `failed: ${error}`;
    }
}

function msSince(start) {
    return (GLib.get_monotonic_time() - start) / 1000;
}

export const tests = {
    async 'a timer fires once, and not at all once removed'() {
        const timers = new Timers();
        const fired = {kept: 0, removed: 0};
        timers.after(10, () => fired.kept++);
        timers.remove(timers.after(10, () => fired.removed++));
        await wait(100);
        assertEqual(fired, {kept: 1, removed: 0}, 'fired');
    },

    async 'a sleep resolves after its delay'() {
        const start = GLib.get_monotonic_time();
        const sleep = new Timers().sleep(50, new Gio.Cancellable());
        assertEqual(await outcome(sleep), 'resolved', 'outcome');
        assertEqual(msSince(start) >= 50, true, 'waited');
    },

    async 'cancelling rejects a sleep at once'() {
        const cancellable = new Gio.Cancellable();
        const start = GLib.get_monotonic_time();
        const sleep = outcome(new Timers().sleep(5000, cancellable));
        cancellable.cancel();
        assertEqual(await sleep, 'cancelled', 'outcome');
        assertEqual(msSince(start) < 1000, true, 'at once');
    },

    async 'clearing rejects every sleep'() {
        const timers = new Timers();
        const sleeps = [1, 2].map(
            () => outcome(timers.sleep(5000, new Gio.Cancellable())));
        timers.clear();
        assertEqual(await Promise.all(sleeps), ['cancelled', 'cancelled'],
            'outcomes');
    },

    async 'a budget is spent once, across pauses'() {
        let spent = 0;
        const budget = new Budget(600, () => spent++);
        budget.run();
        await wait(200);
        budget.pause();
        await wait(300);
        assertEqual(spent, 0, 'spent while paused');
        // about 400 ms left
        budget.run();
        await wait(100);
        assertEqual(spent, 0, 'spent before the rest of it');
        await wait(400);
        assertEqual(spent, 1, 'spent when the rest of it was');
    },
};
