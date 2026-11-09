# settle-lockscreen

A GNOME Shell extension (`settle-lockscreen@uofm-matt.github.io`, GNOME 50 and 51) in which a video plays behind the lock screen and keeps moving for a moment after you unlock. Then it slows to a stop, and the frame it stopped on becomes your desktop picture. At the next lock the video carries on from that frame.

Nothing runs while you use the desktop. The decoder is a separate `mpv` process that exists only from lock until a few seconds after unlock. Installed system-wide, it can also play behind GDM's login screen and hand its last frame to the desktop at login (see [docs/login-screen.md](docs/login-screen.md)).

Other projects play video behind the lock screen: [Live Lock Screen](https://extensions.gnome.org/extension/9419/live-lock-screen) by nick-redwill, and its fork [LiveLockPaper](https://github.com/DeLuca21/LiveLockPaper), which can also play the video as the desktop wallpaper. Neither keeps the frame the video stopped on as the desktop picture or resumes from it. Both are AGPL-3.0 and no code was taken from them; the one idea borrowed is writing to mpv's socket through a queue instead of blocking.

## Install

Needs `mpv`. There is no build step.

```
tools/pack.sh
gnome-extensions install --force settle-lockscreen@uofm-matt.github.io.shell-extension.zip
```

`tools/pack.sh` makes the zip extensions.gnome.org takes, which leaves out the login screen's files, and `install` compiles the schema. In a git checkout it packs the last commit. `tools/pack.sh login` makes the system install that also plays on the login screen. Log out and back in, since a running Wayland shell does not load new extensions, then run `gnome-extensions enable settle-lockscreen@uofm-matt.github.io`.

It stays idle, and your wallpaper stays as it is, until all of these are true:

1. **There is a video**: `~/.local/share/settle-lockscreen/clip.mp4`, or any file mpv can play chosen in the preferences.
2. **Your wallpaper, light and dark, is the video's first frame**, `~/.local/share/settle-lockscreen/first-frame.jpg`. The video starts from it, so nothing jumps when it fades in. *Make its first frame the wallpaper* in the preferences saves it with mpv and sets it. From the first unlock on, the extension sets the wallpaper itself.
3. **Power saver is off**, unless `play-in-power-saver` is set.

If it stays idle, the preferences window says why.

The preferences window sets the video, how long it plays at a time, how long it keeps moving after an unlock and how long it takes to stop. It also turns hardware decoding off, for a GPU on which the video glitches, and lets it play in power saver.

## Where to get a video

This repo ships no video, and you should not put one in it. Use footage you have the right to use, and read the licence of the clip you pick, since terms change.

- [ConnectHV drone footage](https://connecthv.com/drone-footage): 4K clips of the Hudson Valley released under CC0.
- [Pexels videos](https://www.pexels.com/license/): no attribution required and editing allowed, but no redistribution on other stock or wallpaper sites.

Pick a clip that loops without a visible cut and is at least as large as your screen. A 16:9 clip on a 16:10 screen is cropped at the sides, as a "zoom" wallpaper is.

## How it works

- `extension.js` builds a `LockScreen` (`lockScreen.js`). The system install's `extension-login.js` also builds a `Greeter` (`greeter.js`) on the login screen, and in the session a `LoginFrame`, which takes the login screen's frame if `takeFrame.js` did not.
- `video.js` is one playback, shared by both: mpv (`player.js`), its window, the layers that show it and how long it may play. `cover.js` makes a layer that covers a monitor. `setup.js` knows where the files are, whether everything needed to play is in place, and how to make a frame the wallpaper; the preferences window uses it too.
- mpv draws into a window that is never shown. A `Clutter.Clone` of it sits inside each wallpaper actor, so whatever draws over the wallpaper draws over the video.
- At unlock the video slows to a stop, mpv saves that frame as `~/.local/share/settle-lockscreen/new-frame.png`, and it becomes `stop-frame.png` and the desktop picture before the video fades away.
- `handOff.js` carries the login screen's last frame to the session, and `takeFrame.js` with `settle-lockscreen-login.service` takes it before the shell starts. None of them is in the extensions.gnome.org zip.

To check it, run `npm install` once, then `tools/check.sh` in a GNOME session with gjs, glib-compile-schemas and shellcheck installed. It lints, compiles the schemas, checks the promisified methods and settings keys against the code, and runs the tests in `tests/`.

Things that bite when changing it:

- At a lock the shell disables each extension that does not run on the lock screen, and to disable one it first disables every extension enabled after it, then re-enables them. So `LockScreen` can be rebuilt several times in one go, and mpv starts on the next main-loop turn, once that is over.
- `Main.screenShield.active` means the screen has blanked, not that it is locked. Use `locked` and `locked-changed`.
- A minimized Wayland window is suspended. mpv's window is kept off screen with `Meta.Window.inhibit_mapped()` instead, once it has drawn a frame.
- The window actor's `first-frame` signal never fires behind the lock screen, so mpv's own property events say when a frame is decoded.

## Known limits

- **A pause at unlock on a busy desktop.** At unlock the shell re-enables every user extension and reloads its theme. On a laptop with a custom theme, a dock and desktop icons, that froze the video for about a second before the slow-down began. A lighter shell theme shortens it.
- The lock screen blurs and darkens its background, and the video plays inside that background, so it is blurred and darkened too. The login screen does neither, so its `dim` setting exists to match a login theme that darkens.
- Measured on VMs without a GPU: about 45% of one core and 220 MB while playing, nothing after settling.
- Not tested: several monitors, and plugging in a monitor while locked.
- Version 0.2 was tested in VMs on Fedora 44 (GNOME 50) and Ubuntu 26.10 (GNOME 51). Version 0.1 was also tested on Ubuntu 26.04, Fedora Rawhide and an Intel laptop running GNOME 51, and earlier versions also ran on CachyOS (GNOME 51).

Besides running mpv, it writes `new-frame.png`, `stop-frame.png`, `state.json` and, from the preferences, `first-frame.jpg` in `~/.local/share/settle-lockscreen/`, and sets the desktop picture. The system install also writes `login-frame-stamp` there.

## Licence

GPL-2.0-or-later. The full text of version 2 is in [LICENSE](LICENSE). The licence covers this code, not any video you play with it.
