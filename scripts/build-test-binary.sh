#!/usr/bin/env bash
# A test build of the app: debug, with the test door (FEATURES, default
# `harness`; the UI suite adds `e2e`). Never a release:
# scripts/check-test-features.mjs refuses these features there.
#
# The network is whatever the environment says at build time
# (STARTER_BOOTSTRAP_URL, STARTER_RELAY_URL, STARTER_AUTH_MATERIAL: see
# src-tauri/src/conductor.rs), else the public Holochain test servers. The
# Flowsta client id comes from VITE_FLOWSTA_CLIENT_ID or .env.
# Usage: scripts/build-test-binary.sh [extra tauri build args]
set -euo pipefail
cd "$(dirname "$0")/.."
npx tauri build --debug --no-bundle --features "${FEATURES:-harness}" "$@"
