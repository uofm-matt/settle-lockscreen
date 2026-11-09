#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 uofm-matt

# Usage: tools/check.sh
# Runs every check and stops at the first failure. Needs a GNOME session,
# gjs, glib-compile-schemas, shellcheck, and npm install run once.

set -eu
cd "$(dirname "$0")/.."

npm run --silent lint
shellcheck tools/*.sh

tmp=$(mktemp -d)
trap 'rm -r "$tmp"' EXIT
glib-compile-schemas --strict --targetdir="$tmp" schemas
gjs -m tools/check.js

# a scratch data dir and in-memory settings, so the tests touch nothing real
XDG_DATA_HOME=$tmp/data GSETTINGS_SCHEMA_DIR=$tmp GSETTINGS_BACKEND=memory \
    gjs -m tests/run.js
