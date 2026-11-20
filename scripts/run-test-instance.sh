#!/usr/bin/env bash
# Start a test instance of the app (a build from scripts/build-test-binary.sh)
# with its own data folder, admin port and test door, and the one Vault it
# talks to. Every override is read by debug builds only.
# Usage: scripts/run-test-instance.sh <suffix> <port offset> <test door port> [vault port]
set -euo pipefail
SUFFIX="${1:?suffix}"; OFFSET="${2:?port offset, e.g. 100}"; HARNESS="${3:?test door port, e.g. 28901}"; VAULT="${4:-}"
DIR="$HOME/.local/share/starter-test-$SUFFIX"
mkdir -p "$DIR"
cd "$(dirname "$0")/.."
export STARTER_DATA_DIR="$DIR"
# The webview's storage and the app log follow the XDG folders.
export XDG_DATA_HOME="$DIR/xdg" XDG_CACHE_HOME="$DIR/xdg-cache"
export STARTER_TEST_PORT_OFFSET="$OFFSET" STARTER_HARNESS_PORT="$HARNESS"
[ -n "$VAULT" ] && export STARTER_TEST_VAULT_PORT="$VAULT"
# No accessibility bridge: each instance runs in its own dbus session, and
# two started in the same second race for the accessibility bus's socket;
# the loser's window stalls for good.
export NO_AT_BRIDGE=1
exec "${STARTER_TEST_BIN:-src-tauri/target/debug/starter}"
