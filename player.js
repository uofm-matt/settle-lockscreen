// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 uofm-matt

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {logErrorUnlessCancelled} from 'resource:///org/gnome/shell/misc/errorUtils.js';

import {Timers} from './timing.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const APP_ID = 'settle-lockscreen';
const SIGTERM = 15;
const CONNECT_TRIES = 60;
const CONNECT_INTERVAL_MS = 100;
const FRAME_TIMEOUT_MS = 6000;
// mpv's first buffer can be empty
const FIRST_FRAME_WAIT_MS = 300;
const RAMP_STEP_MS = 40;
const REPLY_TIMEOUT_MS = 5000;

const OPTIONS = [
    // the default scalers cost more than decoding on a weak GPU
    '--profile=fast',
    '--vo=gpu',
    '--gpu-context=wayland',
    '--cache=no',
    '--demuxer-readahead-secs=1',
    '--vd-lavc-threads=2',
    '--no-config',
    '--no-terminal',
    '--no-audio',
    '--ytdl=no',
    '--loop-file=inf',
    '--pause',
    '--hr-seek=yes',
    '--force-window=yes',
    '--idle=no',
    '--no-osc',
    '--no-osd-bar',
    '--osd-level=0',
    '--no-border',
    // cover.js puts the proportions back
    '--keepaspect=no',
    '--keepaspect-window=no',
    '--input-default-bindings=no',
    '--input-vo-keyboard=no',
    '--input-cursor=no',
    '--cursor-autohide=no',
    '--stop-screensaver=no',
    '--screenshot-format=png',
    '--screenshot-png-compression=1',
    '--screenshot-tag-colorspace=no',
    `--wayland-app-id=${APP_ID}`,
];

// One mpv process, its window and its control socket. The window is matched
// by pid, because owns_window() says no for a client it has just launched.
export class Player {
    constructor({path, hardwareDecoding, onWindow, onGone}) {
        this._path = path;
        this._hwdec = hardwareDecoding ? 'auto-safe' : 'no';
        this._onWindow = onWindow;
        this._onGone = onGone;
        this._timers = new Timers();
        this._cancellable = new Gio.Cancellable();
        this._process = null;
        this._window = null;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._pending = new Map();
        this._nextId = 0;
        this._writes = [];
        this._writing = false;
        this._properties = {};
        this._frameWaiter = null;
        this._hung = false;
        this._socketPath = GLib.build_filenamev([GLib.get_user_runtime_dir(),
            `${APP_ID}-${GLib.uuid_string_random()}.sock`]);
    }

    // Resolves with the video's size once mpv has decoded a frame.
    async start(position) {
        const argv = [
            'mpv',
            ...OPTIONS,
            `--hwdec=${this._hwdec}`,
            `--start=${position.toFixed(3)}`,
            `--input-ipc-server=${this._socketPath}`,
            '--', this._path,
        ];
        this._process = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE);
        this._process.wait_async(this._cancellable)
            .then(() => this._onGone())
            .catch(logErrorUnlessCancelled);
        global.display.connectObject('window-created', (_display, window) => {
            if (String(window.get_pid()) !== this._process.get_identifier())
                return;

            global.display.disconnectObject(this);
            this._window = window;
            window.connectObject('unmanaged', () => this._onGone(), this);
            this._onWindow(window);
        }, this);

        await this._connect();
        const frame = Promise.withResolvers();
        const timeoutId = this._timers.after(FRAME_TIMEOUT_MS,
            () => frame.reject(
                new Error('mpv showed no frame; can it decode this clip?')));
        this._frameWaiter = {...frame, timeoutId};
        for (const name of ['time-pos', 'dwidth', 'dheight'])
            this._post('observe_property', 0, name);

        const size = await frame.promise;
        await this._timers.sleep(FIRST_FRAME_WAIT_MS, this._cancellable);
        return size;
    }

    async _connect() {
        const address = new Gio.UnixSocketAddress({path: this._socketPath});
        const client = new Gio.SocketClient();

        for (let triesLeft = CONNECT_TRIES; ; triesLeft--) {
            /* eslint-disable no-await-in-loop */
            await this._timers.sleep(CONNECT_INTERVAL_MS, this._cancellable);
            try {
                this._connection =
                    await client.connect_async(address, this._cancellable);
                break;
            } catch (error) {
                // mpv makes the socket a moment after it starts
                if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
                    triesLeft <= 1)
                    throw error;
            }

            /* eslint-enable no-await-in-loop */
        }

        this._output = this._connection.get_output_stream();
        this._input = new Gio.DataInputStream({
            base_stream: this._connection.get_input_stream(),
        });
        this._readLines()
            .then(() => this._onGone())
            .catch(logErrorUnlessCancelled);
    }

    _onProperty(name, value) {
        this._properties[name] = value;
        const {'time-pos': position, dwidth, dheight} = this._properties;
        if (!this._frameWaiter || !Number.isFinite(position) ||
            !dwidth || !dheight)
            return;

        this._timers.remove(this._frameWaiter.timeoutId);
        this._frameWaiter.resolve({width: dwidth, height: dheight});
        this._frameWaiter = null;
        // time-pos would otherwise be reported on every frame
        this._post('unobserve_property', 0);
    }

    // Resolves with the position it paused at.
    async slowToStop(delay, ramp, cancellable) {
        await this.set('pause', false);
        await this._timers.sleep(delay, cancellable);
        for (let t = RAMP_STEP_MS; t < ramp; t += RAMP_STEP_MS) {
            // mpv will not go below 1% speed
            this.tell('speed', Math.max(1 - t / ramp, 0.01));
            // eslint-disable-next-line no-await-in-loop
            await this._timers.sleep(RAMP_STEP_MS, cancellable);
        }

        this.tell('pause', true);
        this.tell('speed', 1);
        return this.get('time-pos');
    }

    async _readLines() {
        const decoder = new TextDecoder();
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const [line] = await this._input.read_line_async(
                GLib.PRIORITY_DEFAULT, this._cancellable);
            if (line === null)
                return;

            this._handle(decoder.decode(line));
        }
    }

    _handle(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            // not a reply or an event of ours
            return;
        }

        if (message.event === 'property-change') {
            this._onProperty(message.name, message.data);
            return;
        }

        const {request_id: id, error, data} = message;
        if (error === 'success')
            this._answer(id, waiting => waiting.resolve(data));
        else if (id !== undefined)
            this._fail(id, new Error(`mpv: ${error}`));
    }

    command(...args) {
        if (!this._output)
            return Promise.reject(new Error('mpv is not connected'));

        const {promise, resolve, reject} = Promise.withResolvers();
        const id = ++this._nextId;
        const timeoutId = this._timers.after(REPLY_TIMEOUT_MS, () => {
            this._hung = true;
            this._fail(id, new Error('mpv did not answer'));
        });
        this._pending.set(id, {resolve, reject, timeoutId});
        this._write({command: args, request_id: id});
        return promise;
    }

    // For requests nobody waits on: their replies match no pending id.
    _post(...args) {
        this._write({command: args});
    }

    _write(message) {
        const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
        this._writes.push({id: message.request_id, bytes});
        this._flush();
    }

    // Async so a stuck mpv cannot freeze the shell; one write at a time.
    async _flush() {
        if (this._writing || !this._output || this._writes.length === 0)
            return;

        this._writing = true;
        const {id, bytes} = this._writes.shift();
        try {
            await this._output.write_all_async(bytes, GLib.PRIORITY_DEFAULT,
                this._cancellable);
        } catch (error) {
            this._fail(id, error);
        }

        this._writing = false;
        this._flush();
    }

    set(property, value) {
        return this.command('set_property', property, value);
    }

    tell(property, value) {
        this._post('set_property', property, value);
    }

    get(property) {
        return this.command('get_property', property);
    }

    _answer(id, settle) {
        const waiting = this._pending.get(id);
        if (!waiting)
            return;

        this._pending.delete(id);
        this._timers.remove(waiting.timeoutId);
        settle(waiting);
    }

    _fail(id, error) {
        this._answer(id, waiting => waiting.reject(error));
    }

    stop() {
        const stopped = new GLib.Error(Gio.IOErrorEnum,
            Gio.IOErrorEnum.CANCELLED, 'mpv stopped');
        this._cancellable.cancel();
        this._timers.clear();
        this._frameWaiter?.reject(stopped);
        this._frameWaiter = null;

        global.display.disconnectObject(this);
        this._window?.disconnectObject(this);
        this._window = null;

        for (const id of [...this._pending.keys()])
            this._fail(id, stopped);
        this._writes = [];

        try {
            this._connection?.close(null);
        } catch {
            // close() throws while a cancelled write is pending
        }

        this._output = null;

        // an mpv that stopped answering may not act on SIGTERM either
        if (this._hung)
            this._process?.force_exit();
        else
            this._process?.send_signal(SIGTERM);
        GLib.unlink(this._socketPath);
    }
}
