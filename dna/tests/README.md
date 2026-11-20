# The DNA tests

These run both DNAs on real Holochain 0.7.1 conductors. They load the
packed files that are committed in `../board/workdir` and
`../my-notes/workdir`, so what is tested is what the app ships. You need
Rust and nothing else: no Holochain CLI, and no build of the DNAs. (Run
`../build.sh` only when you have changed a DNA on purpose.)

```bash
(cd hostile && RUSTFLAGS='--cfg getrandom_backend="custom"' \
  cargo build --release --target wasm32-unknown-unknown)   # the stranger's coordinator
cargo test                        # about ten minutes the first time
```

- `tests/board.rs`: an author writes, edits and deletes; another person
  reads and is refused; a stranger's own coordinator (`hostile/`) is refused
  every write it tries.
- `tests/my_notes.rs`: two devices of one person share a network made from
  one secret and either changes any note; another secret is another
  network; other code on a person's network is still held to what a note
  is; a note restored from the Vault backup and its original are one note.

When you change a rule in an integrity zome, add the write it now refuses
to `hostile/src/lib.rs` and expect the refusal in `tests/board.rs`. A rule
with no test that tries to break it is a comment.
