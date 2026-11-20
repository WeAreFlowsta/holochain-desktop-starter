#!/usr/bin/env bash
# Fetch the conductor and the key store for THIS computer into
# src-tauri/binaries/, under the names tauri.conf.json's externalBin lists.
# Each download is checked against the SHA-256 pinned in
# .github/holochain-sidecars.sha256 and kept only when it matches.
#
# The same releases the release workflow fetches (README, "The conductor
# you ship"). Run it once after cloning, and again after renaming the app.
# Linux and macOS, and Windows in Git Bash.
set -euo pipefail
cd "$(dirname "$0")/.."
HC_RELEASE=holochain-0.7.1
HC_BUILD=holochain-0.7.1-flowsta.4
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
[ -n "$TRIPLE" ] || { echo "rustc was not found: install Rust first (https://rustup.rs)"; exit 1; }
EXT=""; case "$TRIPLE" in *windows*) EXT=".exe" ;; esac
mkdir -p src-tauri/binaries

ours() { node -e 'const b = require("./src-tauri/tauri.conf.json").bundle.externalBin.find((x) => x.endsWith(process.argv[1])); if (!b) process.exit(1); console.log(b)' -- "$1"; }
pinned() { awk -v k="$1" '$1 !~ /^#/ && $2 == k { print $1 }' .github/holochain-sidecars.sha256; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

fetch() { # release, upstream name, the ending of our name
  local base key dest want tmp got
  case "$1" in
    *-flowsta.*) base="https://github.com/WeAreFlowsta/holochain-build/releases/download" ;;
    *) base="https://github.com/holochain/holochain/releases/download" ;;
  esac
  key="$1/$2-$TRIPLE$EXT"
  dest="src-tauri/$(ours "$3")-$TRIPLE$EXT"
  want="$(pinned "$key")"
  [ -n "$want" ] || { echo "$key has no pinned hash in .github/holochain-sidecars.sha256 (is $TRIPLE a platform the app ships for?)"; exit 1; }
  if [ -f "$dest" ] && [ "$(sha "$dest")" = "$want" ]; then
    echo "$dest is already the pinned file"
    return
  fi
  tmp="$(mktemp "$dest.XXXXXX")"
  curl -fsSL "$base/$key" -o "$tmp"
  got="$(sha "$tmp")"
  if [ "$got" != "$want" ]; then
    echo "$key: SHA-256 $got does not match the pinned $want. Nothing was kept."
    exit 1
  fi
  chmod +x "$tmp"
  mv "$tmp" "$dest"
  echo "$dest fetched and checked"
}

fetch "$HC_BUILD" holochain -holochain
fetch "$HC_RELEASE" lair-keystore -lair-keystore
