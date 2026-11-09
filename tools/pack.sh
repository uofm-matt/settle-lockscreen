#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 uofm-matt

# Usage: tools/pack.sh [login]
# Without an argument, packs the extension as extensions.gnome.org takes it.
# With "login", packs the system install, which also plays on the login
# screen and hands its last frame to the session; see docs/login-screen.md.
# In a git checkout it packs the last commit and refuses uncommitted changes.

# shellcheck disable=SC2086 # the source list is split into words on purpose

set -eu
cd "$(dirname "$0")/.."

case $#:${1:-} in
0: | 1:login) ;;
*)
    echo 'Usage: tools/pack.sh [login]' >&2
    exit 2
    ;;
esac

uuid=settle-lockscreen@uofm-matt.github.io
schema=schemas/org.gnome.shell.extensions.settle-lockscreen
sources="lockScreen.js video.js player.js cover.js display.js timing.js
    setup.js LICENSE"
repo=$PWD

tmp=$(mktemp -d)
trap 'rm -r "$tmp"' EXIT
build=$tmp/build
mkdir -p "$build/schemas"

# a checkout of this repository, not a copy vendored inside another one
if [ -e .git ]; then
    commit=$(git rev-parse --short HEAD)
    if ! git diff --quiet HEAD; then
        echo 'Commit the changes first: only the last commit is packed' >&2
        exit 1
    fi
    mkdir "$tmp/tree"
    git archive HEAD | tar -x -C "$tmp/tree"
    cd "$tmp/tree"
else
    commit='none, not a git checkout'
fi

cp prefs.js $sources "$build"
cp $schema.gschema.xml "$build/schemas"

if [ "${1:-}" = login ]; then
    cp extension-login.js "$build/extension.js"
    cp greeter.js handOff.js takeFrame.js settle-lockscreen-login.service \
        "$build"
    cp $schema.login.gschema.xml "$build/schemas"
    sed 's/"unlock-dialog"\]/"unlock-dialog", "gdm"]/' metadata.json \
        >"$build/metadata.json"
    # the login screen needs the gdm session mode
    grep -q '"gdm"' "$build/metadata.json"
    zip=settle-lockscreen-login.zip
else
    cp extension.js metadata.json "$build"
    zip=$uuid.shell-extension.zip
fi

sed -n "s|.* from '\./\([^']*\)';|\1|p" "$build"/*.js | sort -u |
    while read -r module; do
        if [ ! -f "$build/$module" ]; then
            echo "$module is imported but not packed" >&2
            exit 1
        fi
    done

# gnome-extensions packs these four itself, and everything else copied
extras=
for file in "$build"/*; do
    case ${file##*/} in
    extension.js | metadata.json | prefs.js | schemas) ;;
    *) extras="$extras --extra-source=$file" ;;
    esac
done

gnome-extensions pack --force --out-dir="$build" $extras "$build"
mv "$build/$uuid.shell-extension.zip" "$repo/$zip"
cd "$repo"
sha256sum "$zip"
echo "packed from commit $commit"
