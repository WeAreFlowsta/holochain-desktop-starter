#!/bin/bash
# Build both DNAs and pack each as a hApp.
#
#   dna/board     the public network: notes everyone can read
#   dna/my-notes  a private network per person: only their own devices join
#
# Outputs, which the app bundles from src-tauri/resources/ (copy them there
# and update the hashes with `node scripts/check-bundle-sync.mjs --write`):
#   board/workdir/starter_board_v1_happ.happ
#   my-notes/workdir/starter_my_notes_v1_happ.happ
#
# ONCE A RELEASE HAS SHIPPED A DNA, NEVER REBUILD IT. A rebuilt integrity
# zome is a different DNA hash, which is a different, empty network. Commit
# the packed files and change a DNA only on purpose (README, "When your DNA
# changes").
#
# Needs: Rust with the wasm32 target (rust-toolchain.toml pins it), and the
# Holochain CLI 0.7.1 as `hc` or named in $HC
# (cargo install holochain_cli --version 0.7.1).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
HC="${HC:-$(command -v hc-0.7 || command -v hc)}"
[ -n "$HC" ] || { echo "The Holochain CLI (hc 0.7.1) was not found. Set HC or install it."; exit 1; }
cd "$DIR"   # rust-toolchain.toml here pins the compiler for every build below
# The compiler writes the paths of the source files into the zomes. Left
# alone, the packed DNA would carry the home folder of whoever built it, and
# two people building the same source would get two different networks.
REMAP="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${RUSTUP_HOME:-$HOME/.rustup}=/rustup --remap-path-prefix=$DIR=/dna"
export RUSTFLAGS="--cfg getrandom_backend=\"custom\" $REMAP"
export CARGO_TARGET_DIR="$DIR/target"
OUT="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release"

# The agent-linking zomes (which keys are one Flowsta identity), at the tag
# for Holochain 0.7.1. Fetched once into dna/.agent-linking.
LINKING="$DIR/.agent-linking"
if [ ! -d "$LINKING" ]; then
  git clone --quiet --depth 1 --branch v0.4.0 https://github.com/WeAreFlowsta/flowsta-agent-linking "$LINKING"
fi
cargo build --release --target wasm32-unknown-unknown --manifest-path "$LINKING/Cargo.toml"

for dna in board my-notes; do
  [ -d "$DIR/$dna" ] || continue   # a fork that deleted one keeps building
  cargo build --release --target wasm32-unknown-unknown --manifest-path "$DIR/$dna/Cargo.toml"
done

if [ -d "$DIR/board" ]; then
  cp "$OUT/flowsta_agent_linking_integrity.wasm" "$DIR/board/workdir/agent_linking_integrity.wasm"
  cp "$OUT/flowsta_agent_linking_coordinator.wasm" "$DIR/board/workdir/agent_linking_coordinator.wasm"
  cp "$OUT/board_notes_integrity.wasm" "$OUT/board_notes_coordinator.wasm" "$DIR/board/workdir/"
  "$HC" dna pack "$DIR/board/workdir"
  "$HC" app pack "$DIR/board/workdir"
fi
if [ -d "$DIR/my-notes" ]; then
  cp "$OUT/my_notes_integrity.wasm" "$OUT/my_notes_coordinator.wasm" "$DIR/my-notes/workdir/"
  "$HC" dna pack "$DIR/my-notes/workdir"
  "$HC" app pack "$DIR/my-notes/workdir"
fi
echo "Built:"; ls -la "$DIR"/*/workdir/*.happ
