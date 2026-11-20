# What we learned shipping desktop apps on Holochain

The Starter is built the way it is because of things that went wrong in real desktop apps, [Flowsta Vault](https://flowsta.com/vault) and [ProofPoll](https://github.com/WeAreFlowsta/ProofPoll) among them. This page lists those lessons. Each one says what happened, what the template does about it, and where that is in the code, so you know what you are removing before you remove it.

Much of the first two groups is done by the [flowsta-hc-lines](https://github.com/WeAreFlowsta/flowsta-hc-lines) library, and the sign-in group by the [Flowsta Rust SDK](https://github.com/WeAreFlowsta/flowsta-rust-sdk). The files named here are where the template calls them.

Where a lesson depends on how one Holochain version behaves, the version is named. Check it again when you move to a newer one.

## Running Holochain as a child process

### 1. Child processes outlive the app

**What happened.** The app starts a conductor and a key store as child processes. When the app crashed, was force-quit, or was replaced by an installer, the children kept running. The next launch found the conductor's port taken and could not start.

**What the template does.** Two layers. First, the children end with the app even when it has no chance to stop them: a parent-death signal on Linux, a job object on Windows, a watcher process on macOS. Second, at every launch and before anything starts, a sweep stops any conductor or key store whose parent is gone. The sweep finds them by process name, never by port or folder, which is why the two binaries carry your app's own prefix. A child that belongs to a second, live copy of the app is left alone. Every ordinary way out (window close, Quit, Ctrl+C, a signal from a package upgrade) goes through one exit path that stops the conductor before its key store.

**Where.** `src-tauri/src/instance_guard.rs`, `src-tauri/src/lib.rs` (the sweep at the start, the signal route, `RunEvent::Exit`), `src-tauri/src/names.rs` (the sidecar names), `src-tauri/src/conductor.rs` (`stop_lines`).

### 2. The conductor needs watching: it holds memory, and it can stop

**What happened.** Holochain 0.7.1 keeps about 2 GB of memory after an app install until the conductor restarts, and its memory keeps growing while it runs (holochain/holochain#6064). On a laptop that is the difference between an app people keep open and one they close. Separately, a conductor sometimes exits while the app is still open, and the page then shows errors with no way back.

**What the template does.** It restarts the conductor once after any start that installed something, and says so on the start screen. While the app runs, one task watches the conductor. If it stopped, the whole session is started again, at most three times in ten minutes; after that the app says so and waits. Once a minute the task also reads the conductor's memory: above 1 GiB, after 20 minutes of running and at most once in 6 hours, it restarts the conductor at a quiet moment (no call waiting, no write in the last minute).

**Where.** `src-tauri/src/conductor.rs` (`setup`, `spawn_watch`, `MEMORY_POLICY`, `restart_session`), `src-tauri/src/dna.rs` (`ensure_installed` reports whether it installed), `src-tauri/src/commands.rs` (`quiet_now`), `src-tauri/src/notes.rs` (`set_up_my_notes` restarts after its install).

### 3. With auth material and no network, the conductor does not start

**What happened.** A Holochain 0.7.1 conductor whose config carries auth material authenticates with the relay while it starts. With no network it cannot, and it refuses to start at all. An app that should have opened on the person's own data, offline, showed a failed start instead.

**What the template does.** When auth material is set, it asks the bootstrap server's health address before each start. If there is no answer, the conductor is started without the auth material, so everything local works. The app then checks once a minute and restarts Holochain with the auth when the server answers.

**Where.** `src-tauri/src/conductor.rs` (`rendezvous_answers`, `bootstrap_alive`, `spawn_reconnect_when_online`).

### 4. The conductor's local port is open to more than your app

**What happened.** The conductor's admin and app interfaces are websockets on a local port. Two problems follow. A web page in the person's browser can try to open a websocket to a local port. And if something already answers on the port (a second copy of the app, or a conductor an earlier launch left behind), an app that simply connects is now running one profile on another profile's data.

**What the template does.** The interfaces accept exactly one origin: a random value made new at every start of the conductor. It is written to the conductor's config file, which only the person's own account can read, and presented by every connection the app opens. A web page always presents its own address as its origin, so it is refused. And before the conductor is started, the app checks that nothing answers on its port. If something does, it refuses to start and tells the person to quit the other copy.

**Where.** `src-tauri/src/conductor.rs` (`node_origin`, the port check at the top of `start`), `src-tauri/src/names.rs` (`ADMIN_PORT`, `ORIGIN_PREFIX`).

### 5. The key store's files belong together, and they name their own folder

**What happened.** Three things. A partial uninstall left some of the key store's files and removed others; what was left could not be opened, and every start failed with SQLCipher's "hmac check failed". The key store's config holds absolute paths, and its socket address is a URL in which the path is percent-encoded (a space becomes `%20`, as in "Application Support" on every Mac): moving the folder and fixing the paths as plain text left the socket address pointing at the old place. And a data folder with a long path can exceed the length limit for Unix socket paths.

**What the template does.** At launch it treats the passphrase, the key store and its config as one unit: all there, or none. A partial set is cleared, since it is already unreadable. If the databases still cannot be opened, the app resets its local state once and starts fresh, and the code says plainly what that costs the person (a new device key). The config's paths are rewritten through a URL parser, on every start, so a moved folder repairs itself. The socket goes to a short path of the person's own (the runtime folder on Linux, the temp folder on macOS) when its own would be too long.

**Where.** `src-tauri/src/commands.rs` (`AppState::new`, `clear_local_state`, `reset_local_state`), `src-tauri/src/conductor.rs` (`start_holochain`, `socket_plan`), `src-tauri/src/lair.rs`.

## Networks and sync

### 6. The first read after a start can take minutes

**What happened.** A conductor that has just started has to find its peers before a read that asks the network can answer. That first read can wait for minutes. A list that waits on it shows a spinner where the person's own notes should be.

**What the template does.** Every list function in the coordinator zomes has a `_local` twin that answers from what this device already holds and asks no one. The app gives the network 15 seconds, then shows the local answer. The page asks again on its interval, so the network's answer replaces it when it comes. A longer timeout is never the fix.

**Where.** `src-tauri/src/commands.rs` (`read_or_local`, `LIST_WAIT_SECS`), `dna/board/zomes/notes/coordinator/src/lib.rs` and `dna/my-notes/zomes/notes/coordinator/src/lib.rs` (the `_local` functions).

### 7. Peers remember addresses that are gone

**What happened.** Every conductor start has a new network address. The one before it stays in other peers' lists for a while, and each attempt to connect to it held a peer's sync for the whole connect timeout, which is 60 seconds by default. With two devices of one person, after one restarted, a record written on the other arrived in 40 to 214 seconds and once not within ten minutes. A second problem had the same result: a conductor's own registration with the bootstrap server sometimes does not get through after a network blip, and then nobody can find that device.

**What the template does.** It sets the connect timeout to 15 seconds (the same test then gave 2 to 111 seconds; a peer that is there answers in under a second). And a keeper runs once a minute: it checks that this device's address is listed on the bootstrap server, lists it when the conductor's own registration did not get through, and hands the conductor any other peers' addresses it does not have yet.

**Where.** `src-tauri/src/conductor.rs` (`CONNECT_TIMEOUT_S`, `tuning`, `start_keeper` in `start_holochain_attempt`).

### 8. Large sync exchanges fail on the official 0.7.1 conductor

**What happened.** In the official Holochain 0.7.1 binary, a sync exchange in which a peer offers more than about 10,900 record ids fails (holochain/holochain#6062). Two peers with a large difference between them, for example a new device and one with a long history, never catch up. Capping the size of an exchange avoids the failure, but the cap slows the arrival of older history.

**What the template does.** It ships Holochain 0.7.1 built from the official source with a small set of patches, one of which checks offered ids in chunks, and runs with no cap. Every binary the build downloads is checked against a pinned hash. If you ship the official binary, you must set the cap, and the code says where.

**Where.** `src-tauri/src/conductor.rs` (`tuning`), `scripts/fetch-holochain.sh`, `.github/holochain-sidecars.sha256`, and "The conductor you ship" in the README.

### 9. A network seed applies to a whole hApp

**What happened.** A network seed given at install changes every DNA in the hApp. An app with one shared network and one private network cannot put both DNAs in one hApp: seeding the private one would also move the shared one to a network of its own. And a template has its own form of this problem: every fork that keeps the DNA unchanged would land on one shared board.

**What the template does.** Each DNA is its own hApp. The private DNA is installed with the secret the person's Vault gives the app, so each person gets a network only their devices can join. The board is installed with the app's identifier as its seed, so a fork gets a board of its own with no rebuild of the DNA. An app that is already installed keeps the network it joined; the seed is not read again.

**Where.** `src-tauri/src/dna.rs`, `src-tauri/src/names.rs` (`BOARD_NETWORK`), `dna/board/workdir/dna.yaml`, `src-tauri/src/notes.rs` (`set_up_my_notes`).

### 10. A network of one person's devices has no peer that stays on

**What happened.** On a private network the only peers are the person's own devices. One device alone keeps its notes and syncs with nobody, and when that device is lost there is no peer to restore from. A backup solves that and brings three traps of its own: a new, still empty device overwrites the last good backup; a restored note shows twice when the original arrives later from a device that was only off; and a note the person deleted comes back from an old backup.

**What the template does.** The person's notes are backed up to their Flowsta Vault every hour and 30 seconds after each write. The backup carries a record count, and a backup with no records is not written over one that has some. A restored note is a new record that remembers the id it had, and the list shows a note and its restored copy once. A restore writes only notes this device has never seen, so a deleted note stays deleted and a restore can be run again at any time.

**Where.** `src/lib/backup.ts`, `src/lib/restore.ts`, `src-tauri/src/notes.rs` (`build_backup`, `restore_my_notes`), `dna/my-notes/zomes/notes/coordinator/src/lib.rs` (`restore_note`), `dna/tests/tests/my_notes.rs`.

## DNAs and their rules

### 11. Anyone can run their own functions on your network

**What happened.** A coordinator zome is not part of what names a network. Anyone can write a coordinator of their own and run it against your DNA. Rules that live in your functions ("only the author may edit") then protect nothing. Only the integrity zome's rules, which every peer runs on every record it is asked to hold, stand between a stranger and other people's records.

**What the template does.** The board's integrity zome checks the author on every edit, delete, listing and unlisting, and sets a size limit that every peer enforces. Every edit names a note's first record, never another edit, so nobody can insert themselves into a chain of edits. The tests include a stranger's coordinator that tries to delete, rewrite, list and unlist other people's notes on real conductors, and every attempt must be refused. When you add a rule, add the write it refuses to that coordinator.

**Where.** `dna/board/zomes/notes/integrity/src/lib.rs`, `dna/tests/hostile/src/lib.rs`, `dna/tests/tests/board.rs`.

### 12. A rebuilt DNA is a different network

**What happened.** The integrity zome's compiled bytes are part of what names the network. Building the same source again, with another compiler version or on another machine, can give other bytes, and so another, empty network. A release built that way splits its users from everyone on the release before it.

**What the template does.** The packed DNAs are committed, and the app bundles those exact files. A script checks that the packed files, the app's copies and the hashes compiled into the app all agree; CI runs it, and the DNA tests load the committed files, so what is tested is what ships. For a DNA that must change, the app never uninstalls: an installed cell holds the person's own records, so a new version is installed beside the old one.

**Where.** `dna/build.sh` (the warning at its top), `scripts/check-bundle-sync.mjs`, `src-tauri/src/kits.rs` (the hashes), `src-tauri/src/dna.rs`, `.github/workflows/test.yml`, and "When your DNA changes" in the README.

## Sign-in and devices

### 13. One key per device, and its seed is never made twice

**What happened.** If a device's key is lost, the device can no longer change what it wrote. If a key is made again over a damaged file, the same thing happens without anyone noticing. And if one key runs on two conductors (a copied data folder, a restore onto a second machine), the two do not sync with each other. A further cost came from the usual way of letting an app sign zome calls: a signing grant is a record on the person's chain, so an app that makes one at each start adds a record to the person's history every time it opens.

**What the template does.** The app creates the device's seed itself and keeps a recovery copy in a file in the profile, so a key store that has to be made again gets the same key back. A damaged seed file is an error and is never replaced by a new seed. When local state must be reset, the old seed is set aside, not deleted and not used again. Each device has its own key on both networks, and which keys are one person is a separate, signed record. Zome calls are signed with the device's key in the key store, so no grant is written and starting the app adds nothing to anyone's history.

**Where.** `src-tauri/src/device_seed.rs`, `src-tauri/src/lair.rs` (the import into the key store), `src-tauri/src/dna.rs` (`connect`), `src-tauri/src/commands.rs` (`clear_local_state`).

### 14. The app must know who is at the computer

**What happened.** Two people share one computer account, or one person has two identities. An app with one data folder shows the second person the first person's data and writes under the first person's key. The opposite mistake is as bad for everyday use: an app that needs the Vault unlocked for every write is an app people stop using.

**What the template does.** One profile per Flowsta identity: its own key, key store, conductor data and link files. The profile is chosen at launch from the identity the Vault holds. Every command that writes goes through one check: refused when this device is not signed in, refused when the Vault is unlocked as another identity (someone else is at the computer), allowed when the Vault is closed or locked. The few actions that copy something from the live Vault (the profile's name and picture, the private network's secret) use a stricter check that also refuses a closed or locked Vault. A profile is never bound again to another identity; disconnecting first is the only way.

**Where.** `src-tauri/src/profiles.rs`, `src-tauri/src/commands.rs` (`require_identity_link`, `require_identity_match`, and the last step of sign-in), `src-tauri/src/lib.rs` (the profile choice in `setup`).

### 15. Every Tauri app presents the same origin

**What happened.** The Vault answers local requests and decides who is asking by their origin. Every Tauri app's webview presents the same one, so the origin cannot tell your app from another app on the same computer. And a request made from Rust carries no origin at all unless you set one, so the Vault answered it as a stranger: without the person's name and picture, and with other routes refused.

**What the template does.** Your app's client id says which app is asking, and the Vault gives each link between an app and an identity a private token. The token is kept in the profile, written so that a failed write never leaves half of one, and is never logged. On the Rust side one client carries the origin, the client id and the token on every request. The page takes the Vault's address and the token from that same client, so the two can never talk to two different Vaults. When the Vault no longer knows the token, the app forgets it and offers to sign in again.

**Where.** `src-tauri/src/vault_probe.rs`, `src-tauri/src/link_token.rs`.

## Updates and releases

### 16. An update needs two signatures, and a version it can sort

**What happened.** Two separate things. An updater that trusts one key trusts whoever holds the build machine's secrets: that key proves a file came from your build, not that you meant to publish it. And the updater compares versions by semver, where a pre-release part that mixes letters and digits is compared as text: `beta10` sorts below `beta9`, so no copy on `beta9` ever took it.

**What the template does.** An installed copy takes an update only when both checks pass: the updater's signature on the file, and a release manifest signed in a Flowsta Vault by a release identity whose DID is compiled into that copy. The manifest names the version, the channel and every file's SHA-256, and is checked before anything is downloaded. The newest accepted sequence is kept, so an older manifest cannot be replayed. A build with no release signer listed does not update itself and says so; it never falls back to trusting someone else. A unit test fails the build on a version written like `beta10`. The check itself writes one line to the log each time, so a quiet updater can be told from one that never ran.

**Where.** `src-tauri/src/updater.rs`, `src-tauri/src/names.rs` (`RELEASE_SIGNERS`), `scripts/release-manifest.mjs`, RELEASING.md.

### 17. Stop Holochain before the files under it are replaced

**What happened.** An installer that runs while the conductor and key store are running fails on Windows, which cannot replace files in use, and on any system it risks ending a database in the middle of a write. On Linux the order has a trap of its own: the install asks for the computer's password, the person can cancel, and an app that had already stopped Holochain was then left running with nothing behind it.

**What the template does.** On Windows and macOS the conductor and key store are stopped cleanly, and then the update is installed, at "Restart to update" or on quit. On Linux the update is installed first, and Holochain is stopped only after the install went through, so a cancel leaves the app as it was. If an install fails, what the updater remembered is put back, so the same update is offered again.

**Where.** `src-tauri/src/updater.rs` (`INSTALLS_FIRST`, the install and on-quit functions), `src-tauri/src/lib.rs` (`RunEvent::Exit`).

### 18. Keep a copy of the Holochain you run

**What happened.** A breaking Holochain version is a new conductor database and a new network. An app that has moved to it still has to read each device's data from the version before, which takes that version's conductor, key store and hApps. A release that no longer bundles them cannot read a device that skipped the releases in between.

**What the template does.** Once per run, after the conductor is up, the app sets aside a compressed copy of what it runs (the conductor, the key store and the hApps) in its data folder, with the hApps' hashes compiled in so a later release can check every file before using it. It costs a few megabytes now and is for later. The template runs one Holochain version and does not contain the move to the next one; this is the part that has to be on people's devices before that day. Separately, the Holochain client crate is named in two files only, so those are the files that change.

**Where.** `src-tauri/src/kits.rs`, `scripts/kit-hashes.mjs`, `src-tauri/src/hc.rs` and `src-tauri/src/dna.rs` (with one admin call in `src-tauri/src/commands.rs`, the only files that name the Holochain client).

## Testing

### 19. Test doors must never ship

**What happened.** Testing a second device, an offline start or a restart needs ways into the app that a released app must not have: a local server that drives its commands, an embedded WebDriver, switches for the data folder and the ports. One build flag passed in the wrong workflow puts them in front of users.

**What the template does.** The test server and the WebDriver are cargo features that are off by default and built from optional dependencies. A script fails the build if either is on by default, is not optional, or is passed by any workflow that builds the app. The environment switches (`STARTER_DATA_DIR`, `STARTER_TEST_PORT_OFFSET` and the others) are read by debug builds only, and the test door's own port (`STARTER_HARNESS_PORT`) only by a build with the `harness` feature. With them, `scripts/run-test-instance.sh` starts a copy of the app with its own data folder and ports. Run it twice for two copies side by side on one machine, and drive each through its test door (`/dev/status`, `/dev/op`).

**Where.** `src-tauri/src/harness.rs`, `scripts/check-test-features.mjs`, `scripts/run-test-instance.sh`, `scripts/build-test-binary.sh`, `src-tauri/src/conductor.rs` (`test_port_offset`).

### 20. A test that passes can still show a screen that makes no sense

**What happened.** UI tests checked the thing each was written for and passed, while the window showed two things that cannot both be true (the header offers to sign in while the page shows the form to write), or text no person would write ("1 notes", a raw error code, `undefined`).

**What the template does.** After every UI test, the window's content is read and run through one set of checks for screens that do not make sense, and each spec also collects wording the app must never show. A spec fails at its end if anything stood for about 40 seconds. When someone reports a screen that makes no sense, the check is added first, with that screen as its unit test, and then the screen is fixed. The UI suite drives the real app, from an empty data folder, and never touches an installed copy.

**Where.** `src/lib/sense.ts`, `src/lib/sense.test.ts`, `e2e/specs/_helpers.ts`, `e2e/README.md`.
