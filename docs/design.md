# Design

How the extension works and why it is built this way, for reviewers and for anyone changing it. README.md has the user's view; docs/login-screen.md has the system install.

## A player outside the shell

The shell cannot decode video inside a wallpaper actor without stalling the compositor, so mpv decodes in its own process and draws into its own Wayland window. `video.js` adopts that window as soon as it maps: its actor goes transparent, the window leaves the window list, and once mpv has drawn a frame, `Meta.Window.inhibit_mapped()` takes it off screen. Minimizing would not do, because a minimized Wayland window stops drawing. A `Clutter.Clone` of the window actor goes inside each wallpaper actor (`cover.js` sizes it to cover the monitor), so whatever the shell draws over the wallpaper, it draws over the video.

`player.js` starts mpv with a fixed argument list: `--no-config`, no audio, no input bindings, no OSD, no network fetches (`--ytdl=no`), paused, at the saved position. It drives mpv over a JSON IPC socket in `$XDG_RUNTIME_DIR`. Commands that need an answer time out; an mpv that stops answering is killed instead of asked to quit. mpv runs while the screen is locked and for the few seconds of the slow-down after an unlock. Disabling the extension stops it.

## Session modes

`session-modes` lists `unlock-dialog` because the video plays behind the lock screen. Nothing in the extension reads input; it connects no keyboard signals. The system install also lists `gdm`, to play on the login screen.

## One lock

1. `locked-changed` schedules a start on the next main-loop turn. At a lock, the shell disables every extension that does not run on the lock screen, and to disable one it first disables every extension enabled after it, then re-enables them. So this extension can be rebuilt several times in one turn, and starting in the next turn spawns one mpv, not several.
2. It plays only if the wallpaper, light and dark, is the video's first frame or the frame it last stopped on, with `state.json` naming the same clip; the video exists; mpv is installed; power saver is off (unless allowed); and the display is on. Otherwise the wallpaper is left alone and nothing runs.
3. mpv starts at the saved position. The layers go into the desktop's and the lock screen's wallpaper actors and fade in over 600 ms. Since the frame under them is the frame mpv starts on, nothing jumps. The video plays while the display is on, for `lock-play-seconds` of display-on time.
4. At unlock it keeps moving for `settle-delay-ms`, slows to a stop over `settle-ramp-ms` and pauses. mpv saves the frame as `new-frame.png`, which becomes `stop-frame.png` and the wallpaper. Once the shell has loaded it (or after 3 s), the video fades out and mpv is stopped. Locking again during the slow-down plays on.

If the wallpaper changes while the extension waits on something, even to the extension's own first frame, it stops and leaves the wallpaper alone.

## Private shell API

Each use is marked `Hack:` in the code.

- `BackgroundManager.prototype._createBackgroundActor`, wrapped with an `InjectionManager`: wallpaper actors the shell creates while the video plays (a monitor change, the lock screen's own) get a layer too.
- `Main.layoutManager._bgManagers` and the unlock dialog's `_bgManagers`: the only way to reach the wallpaper actors, and their `changed` signal says when the new wallpaper has loaded.
- The focus is given back to the window that had it, since mapping mpv's window took it.

The system install also uses:

- `ScreenShield.prototype._ensureUnlockDialog`: the login dialog is built late, and again after a destroy.
- `LoginDialog.prototype._startSession` and the dialog's GDM client, `_greeter`: GDM ends the login screen as soon as the session starts, so the start call is held for the slow-down. A timer makes the call at the latest `settle-delay-ms + settle-ramp-ms + 2 s` after the password, and any failure makes it at once.
- `Main.screenShield._dialog` and the dialog's `_user`.
- `Main.layoutManager._startingUp`: when the wallpaper is the extension's, animations are inhibited from enable to `startup-complete`, so the session shows the login frame at once. This works only where the extension is enabled before the startup animation begins, which in tests was true on Fedora and not on Ubuntu.

## Cancellation

`LockScreen` and the login frame each hold a `Gio.Cancellable` for their own reads, the greeter holds one per held login, and every stop rejects pending work with a `CANCELLED` `GLib.Error`. Owners log errors with the shell's `logErrorUnlessCancelled`, so a stop is silent and a real failure is logged once. `disable()` cancels, clears every timer, stops mpv, removes the layers, clears the injections and disconnects every signal. A playing video is dropped then; only a settle saves its position.

## Files

In `~/.local/share/settle-lockscreen/`: `first-frame.jpg` (from the preferences), `new-frame.png` (while settling), `stop-frame.png`, `state.json` (position and clip), and in the system install `login-frame-stamp`. In the system install, also `/run/settle-lockscreen-login/`, described in docs/login-screen.md.

## Checks

`tools/check.sh` runs lint, shellcheck, a strict schema compile, `tools/check.js` (every `Gio._promisify` names methods that exist; the code and the schemas name the same keys) and the tests in `tests/`. `tools/pack.sh` packs the last commit and checks that every module the code imports is in the zip.
