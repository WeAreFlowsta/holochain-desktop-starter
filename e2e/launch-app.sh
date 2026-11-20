#!/usr/bin/env bash
# Launches the e2e build of the app on an ISOLATED data folder for the UI
# tests (see e2e/README.md). @wdio/tauri-service runs this instead of the
# binary, so the app never sees a person's own copy: its data lives in
# e2e/profile (wiped per run), its conductor on its own port, and it talks
# only to the Vault test instance wdio.conf.ts started (if any), never to
# an installed Vault.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# The last vault spec (06) is the same person on a NEW device: a second,
# empty data folder against the same Vault. 05 leaves the marker.
DEVICE=a; [ -f "$HERE/profile/next-is-a-new-device" ] && DEVICE=b
export STARTER_DATA_DIR="${STARTER_E2E_DATA_DIR:-$HERE/profile/$DEVICE}"
mkdir -p "$STARTER_DATA_DIR"
# The webview's storage and the app's log follow the XDG folders.
export XDG_DATA_HOME="$STARTER_DATA_DIR/xdg" XDG_CACHE_HOME="$STARTER_DATA_DIR/xdg-cache"
mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
export STARTER_TEST_PORT_OFFSET="${STARTER_E2E_PORT_OFFSET:-200}"
export STARTER_HARNESS_PORT="${STARTER_E2E_HARNESS_PORT:-28911}"
# With no Vault test instance, a port nothing answers on: the app must
# never find a person's installed Vault from inside a test.
VPORT="${STARTER_E2E_VAULT_PORT:-$(cat "$HERE/profile/vault-port" 2>/dev/null || echo 27999)}"
export STARTER_TEST_VAULT_PORT="$VPORT"
# On a Wayland desktop the window is an XWayland window, which xdotool can see.
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] && [ -z "${STARTER_E2E_NATIVE_WAYLAND:-}" ]; then export GDK_BACKEND=x11; fi
APP="$(cd "$HERE/.." && pwd)/src-tauri/target/debug/starter"
exec dbus-run-session -- "$APP" "$@"
