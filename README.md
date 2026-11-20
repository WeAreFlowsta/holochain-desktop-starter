# Holochain Desktop Starter

A complete, working desktop app on Holochain that you fork and rename.

It starts and looks after its own Holochain conductor and key store, signs people in with [Flowsta](https://flowsta.com), keeps a public record on a shared network and a private record on a network of the person's own devices, backs both up to the person's Flowsta Vault and restores from it, works across their devices, updates itself from signed releases, and comes with the tests that prove each of those.

The example on top is deliberately tiny: **Notes**, one page with two tabs.

| | The board | My notes |
|---|---|---|
| The network | one, shared by everyone running the app | one per person: only that person's own devices ever join it |
| Who holds the data | every peer | the person's devices, and nobody else |
| Who can read it | everyone | the person, on any device they sign in on |
| Edit and delete | on the device that wrote the note (the network's rules check the author) | on any of the person's devices |
| In the Vault backup | the person's own notes | yes, and restored from it |

Each tab is its own DNA, so you see both shapes side by side.

Built with [Tauri 2](https://tauri.app), Rust, [Qwik](https://qwik.dev) and Holochain 0.7.1, on two libraries you can also use on their own: [flowsta-hc-lines](https://github.com/WeAreFlowsta/flowsta-hc-lines) (running Holochain inside a desktop app) and the [Flowsta Rust SDK](https://github.com/WeAreFlowsta/flowsta-rust-sdk). MIT licensed.

## Start

You need [Rust](https://rustup.rs), Node 22, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system.

```bash
npm install
scripts/fetch-holochain.sh        # the conductor and key store for your platform, checked against pinned hashes (on Windows: run it in Git Bash)
npm run tauri dev
```

The window opens, says "Starting Holochain..." for about half a minute the first time, and shows the board. Reading works at once. Writing asks you to sign in: install [Flowsta Vault](https://flowsta.com/vault), create an identity, and press "Sign in with Flowsta".

It runs against the public Holochain test servers with no server of your own. They are for trying things out: see [Servers](#servers) before you release. The builds published on this repository's releases page use them too, so their board is a shared test space: anyone trying the Starter writes on it, and it can be reset at any time.

## Make it yours

**1. Rename it.** One command gives the app its own name, identifier, program names, update channels and board (add `--port 4500` to give it its own conductor port too):

```bash
node scripts/rename-app.mjs --name "My App" --identifier org.example.myapp --slug myapp --repo you/my-app
```

It prints what is left for you to do by hand.

**2. Register it.** Register your app at [dev.flowsta.com](https://dev.flowsta.com) and put its client id in `.env` (`.env.example` is the template). People see your app's registered name when they sign in, and the Vault tells apps on one computer apart by it. Give it these origins, which are where the page runs from:

- `tauri://localhost` (the installed app on macOS and Linux)
- `http://tauri.localhost` (the installed app on Windows)
- `http://localhost:5174` (`npm run tauri dev`)

**3. Change the record.** A note is `Note { text }`. Rename it and give it your fields in three places:

- `dna/board/zomes/notes/` and `dna/my-notes/zomes/notes/`: the record and what a valid one is (`validate_note`). Then `dna/build.sh` and `node scripts/check-bundle-sync.mjs --write`.
- `src-tauri/src/notes.rs`: the commands the page calls.
- `src/routes/index.tsx` and `src/lib/holochain.ts`: the page.

**Adding a second record** beside the note (a comment, a tag, a list) is the same three places again, and nothing else:

1. In the DNA that should hold it: a new struct and a line in `EntryTypes`, a link type if it is listed, and its rules in `validate`. Add the write your rules refuse to `dna/tests/hostile` and expect the refusal in `dna/tests`. Then `dna/build.sh` and `node scripts/check-bundle-sync.mjs --write`. Do this before your first release: after it, a changed integrity zome is a new network (see "When your DNA changes").
2. In `src-tauri/src/notes.rs` (or a file beside it): the commands, each write going through `require_identity_link` first, registered in `lib.rs`.
3. On the page: a wrapper in `src/lib/holochain.ts` (call `requestBackupSoon()` after a write), then your page. Add what it shows to `src/lib/sense.ts` so the tests check that it makes sense.

Add it to the backup too (`build_backup` in `notes.rs`), and to the restore if it lives on the private network (`src/lib/restore.ts`).

**Want only one of the two networks?**

- *Only the board:* delete `dna/my-notes`, its `App` constant in `src-tauri/src/dna.rs` and its connection in `connect` there, its `KitFile` in `kits.rs` and its line in `tauri.conf.json` (`bundle.resources`), `set_up_my_notes` and the `MyNotes` place in `notes.rs`, the `my_notes` client in `AppState`, the test in `dna/tests/tests/my_notes.rs`, and the tab. The compiler names every place you missed.
- *Only the private network:* keep the board's DNA and remove its notes zome and its tab. Sign-in lives in the board's DNA (the record that links a device's key to a Flowsta identity is written to the shared network, where every device can check it), so an app with only private data still installs it.

## How it works

**Running Holochain** (`src-tauri/src/conductor.rs`, on `flowsta-hc-lines`). The app starts a conductor and a key store as child processes, restarts the conductor once after a first install (Holochain 0.7.1 keeps about 2 GB after one until it restarts), watches it, starts it again if it stops, restarts it at a quiet moment when it holds over 1 GiB, and stops both cleanly at quit. After a crash or a forced quit nothing is left running: a parent-death signal on Linux, a job object on Windows, a watcher process on macOS, and a sweep at the next launch.

**Signing in** (`src-tauri/src/commands.rs`, on the Flowsta Rust SDK). Each device has a key of its own. Signing in links that key to the person's Flowsta identity: the Vault signs the pair, the device signs it too, and the record goes on the board's network, where anyone can check it with two signature checks and no server. From then on every device the person signs in on reads as the same person. The Vault only has to be open for the sign-in itself; everyday use works with it closed or locked.

**One profile per identity** (`profiles.rs`). Two people on one computer account, or one person's two identities, each get the app as their own: separate keys, separate data.

**The private network** (`notes.rs`, `set_up_my_notes`). The Vault gives the app a secret that is the same on every one of the person's devices and different for every person and every app. The private DNA is installed with it as its network seed, so each person has a network of their own. With only their own devices as peers, notes move between two devices when both are on; one device alone keeps its notes.

**Backups** (`src/lib/backup.ts`). The person's notes go to their Vault every hour and 30 seconds after each write. The Vault keeps them encrypted on the person's own devices, and the person can export them from the Vault at any time: their data is theirs to take, whatever happens to your app. 

**Restoring** (`src/lib/restore.ts`, `restore_my_notes` in `notes.rs`). Private notes exist on the person's devices only, so the backup is what is left when a device is lost. When the person opens "My notes" with their Vault unlocked, the app reads this app's backups from the Vault (the one this device made and the ones the Vault holds from their other devices) and, if they hold notes this device does not, offers to restore them. A restored note is a new record that remembers the id it had, so a note is never shown twice when the original arrives later from a device that was only off. Board notes need no restore: every peer holds the board.

**Updates** (`updater.rs`). The app checks for a new release on start and every few hours, and installs only one whose manifest your release identity signed: see [RELEASING.md](RELEASING.md).

**Names.** The board shows who wrote a note as "You" or a short key. To show people's Flowsta display names or usernames, ask for that scope when your app signs in (see the [Flowsta docs](https://docs.flowsta.com)).

## The rules are tested by trying to break them

A coordinator zome is not part of what names a network, so anyone can run functions of their own against yours. Only the integrity zome's rules stand between them and other people's records. `dna/tests` runs both DNAs on real conductors, including a stranger's own coordinator (`dna/tests/hostile`) that tries to delete, rewrite, list and unlist other people's notes, and expects every attempt to be refused.

```bash
cd dna/tests && cat README.md
```

When you change a rule, add the write it now refuses to the stranger's coordinator. A rule with no test that tries to break it is a comment.

## When your DNA changes

- **A coordinator zome changes** (your functions, not your rules): it is not part of the network's identity. Ship the new one with the app and it reaches the same network. `flowsta-hc-lines` has the call that swaps it on an installed cell.
- **An integrity zome changes** (your rules or your record): that is a new network, empty. Install the new version **beside** the old one, never over it, and carry people's records across with a proof the new rules check. Never uninstall the old cell: it holds the person's own records.

Once a release has shipped a DNA, never rebuild it: a rebuilt integrity zome is a different network. The packed DNAs are committed for that reason, and CI tests the committed files.

[ProofPoll](https://github.com/WeAreFlowsta/ProofPoll) is the worked example of carrying records across five DNA versions and two Holochain lines.

## The conductor you ship

`scripts/fetch-holochain.sh` and the release workflow fetch Holochain 0.7.1 built from the official source with a small set of patches, published at [WeAreFlowsta/holochain-build](https://github.com/WeAreFlowsta/holochain-build), each binary checked against the hashes in `.github/holochain-sidecars.sha256`. The patches fix sync problems we met on long histories. To ship the official binary instead, change the release names in those two places, replace the hashes in `.github/holochain-sidecars.sha256` with the official files' own, and set a gossip cap in `tuning()` in `conductor.rs` (the comment there says why).

## Tests

| | Needs | Run |
|---|---|---|
| Rust unit tests | the sidecars fetched and the page built once (`npm run build`): Tauri's build script checks both are there | `cd src-tauri && cargo test --lib` |
| Page unit tests | nothing | `npm run test:unit` |
| DNA rules on real conductors | nothing | `dna/tests/README.md` |
| UI suite, signed out | Linux, a display | `npm run e2e:build && npm run e2e` |
| UI suite, signed in | Linux, a Flowsta Vault test build | `e2e/README.md` |

The first three run on Linux, macOS and Windows, and CI runs them on every push. The UI suite runs on Linux.

## Servers

Before you release, run your own:

- **A bootstrap and relay server**, so your users find each other on a network you control. Set its address at build time (`STARTER_BOOTSTRAP_URL`).
- **An always-on node** for the board, so a note written by someone who then closes their laptop is there for the next person. The simplest one is this app itself, left running on a machine that stays on: every running copy holds the board and serves it to the others.

The private network needs no always-on node: its peers are the person's own devices.

[docs/SERVERS.md](docs/SERVERS.md) has the recipe for both, the settings, and how to check they work. [docs/WHAT_WE_LEARNED.md](docs/WHAT_WE_LEARNED.md) is why the Starter is built the way it is.

## Releasing

[RELEASING.md](RELEASING.md): the secrets the release workflow reads, code signing on Windows and macOS, the updater's key, and signing a release with your own Flowsta identity.

## License

MIT.
