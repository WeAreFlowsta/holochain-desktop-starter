# Your own servers

A fresh fork runs against the public Holochain test servers, so it works with no server of your own. Those servers are for trying things out. Before you release, run two things yourself:

1. **A bootstrap and relay server**: one small VM.
2. **An always-on node**: at least one machine that runs your board and stays on.

Then build the app with the settings that point it at them.

This page is for Holochain 0.7.1, the version the Starter runs. The private network ("My notes") needs none of this: its only peers are the person's own devices.

## Why a released app needs them

**Peers find each other through the bootstrap server.** A conductor that starts knows nobody. It registers its address with the bootstrap server and asks it who else is on the same network. Every copy of your app must name the same bootstrap server, or the copies never meet. On the public test servers your users share a meeting point with everyone else's experiments, and it can be reset or go away at any time.

**The relay carries traffic for peers that cannot connect directly.** Two laptops behind home routers often cannot open a direct connection. The relay passes their (encrypted) traffic until they can, or for as long as they cannot. In Holochain 0.7 the bootstrap server program also serves the relay, so one VM does both jobs.

**A note must be held by a peer that stays on.** The board is stored by the peers that are running. If a person writes a note and closes their laptop a few seconds later, and nobody else was online, the note is on that laptop only. The next person who opens the app sees an empty board. An always-on node is a peer that is there to receive the note and to serve it later.

**A person on a new device needs peers that hold their history.** When someone signs in on a second computer, the app reads from the network which keys belong to their identity and which board notes are theirs. That works only if some peer that holds those records is online. If their first computer is off, the always-on node is that peer.

**The private network needs neither.** Each person's private network is joined only by their own devices, so no node of yours can be on it. Notes there move between two of the person's devices when both are on, and the Vault backup covers a lost device. (The private network still uses your bootstrap and relay server for the person's devices to find each other. It does not need the always-on node.)

## 1. The bootstrap and relay server

The server is `kitsune2-bootstrap-srv`, published by the Holochain project as a container image. It keeps only short-lived address notes, so it has no data to back up and can be rebuilt at any time.

### What you need

- A small Linux VM with a public IPv4 address. 1 GB of memory has been enough for ours.
- **A static address.** If the VM's address changes when it is stopped and started, every installed copy of your app loses its meeting point until DNS is corrected. Reserve the address with your provider before you point DNS at it.
- A hostname you control, for example `bootstrap.example.org`, with an A record that points at the VM. If your DNS provider can proxy traffic, turn the proxy off for this record: we have only run the server with clients connecting to it directly.
- Docker with Docker Compose (`curl -fsSL https://get.docker.com | sh`). Some systems' own `docker.io` package comes without `docker compose`; the line here installs both.
- certbot, from your system's packages.

### The firewall

| Port | For |
|---|---|
| TCP 443 | bootstrap requests and the relay |
| TCP 80 | certbot, when it gets or renews the certificate |
| UDP 7842 | QUIC address discovery: how a peer learns its own public address (the server's default port in production mode) |

### The certificate

With nothing else listening on port 80:

```bash
sudo certbot certonly --standalone -d bootstrap.example.org
```

The certificate and its key are now under `/etc/letsencrypt/live/bootstrap.example.org/`.

The certificate is not optional, and there is no plain `http` shortcut for a first try: a Holochain 0.7.1 conductor given a relay address that starts with `http://` does not start (`Disallowed plaintext relay URL`).

### The server

Create `docker-compose.yml` in a folder of its own on the VM:

```yaml
services:
  bootstrap:
    image: ghcr.io/holochain/kitsune2_bootstrap_srv:v0.5.1
    container_name: bootstrap
    network_mode: host
    user: root          # it binds port 443 and reads the certificate's key
    restart: unless-stopped
    command:
      - "kitsune2-bootstrap-srv"
      - "--production"
      - "--listen"
      - "0.0.0.0:443"
      - "--tls-cert"
      - "/etc/letsencrypt/live/bootstrap.example.org/fullchain.pem"
      - "--tls-key"
      - "/etc/letsencrypt/live/bootstrap.example.org/privkey.pem"
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt:ro
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"
```

What each part is for:

- `v0.5.1` is the kitsune2 0.5 line, which is what Holochain 0.7.1 speaks. A server from the 0.4 line is for Holochain 0.6 and does not serve 0.7 conductors.
- `--production` sets the limits for a real server. Without it the server runs with small test settings.
- `network_mode: host` makes the server bind the VM's own ports, with no port mapping to keep in step.
- The `logging` block caps the log. Without it, Docker's log file grows until the disk is full.

Start it and read its log:

```bash
docker compose up -d
docker logs bootstrap --tail 50
```

### Check it

From any other computer:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://bootstrap.example.org/health
```

It must print `200`. When auth material is set, the app asks the same address before it starts Holochain. Either way, if this fails from your desk, your users' apps cannot find each other.

### When the certificate renews

certbot renews the certificate by itself. The running server keeps using the one it loaded at its start, so restart it after a renewal:

```bash
docker restart bootstrap
```

A restart takes seconds. Running apps register again by themselves.

### Optional: who may use your server

As configured above, the server is open: any Holochain app that knows its address can use it. That is a reasonable start. If you later need to limit use, the server can ask a small web service of yours (an "authentication hook") about each client. Add to the `command` list:

```yaml
      - "--authentication-hook-server"
      - "https://auth.example.org"
```

How it works:

1. Your app's conductor sends its auth material (some bytes that you choose, compiled into the app) to the bootstrap server.
2. The bootstrap server passes those bytes to your service: `PUT https://auth.example.org/authenticate`, with the bytes as the body and `Content-Type: application/octet-stream`.
3. Your service answers `200` with JSON `{"authToken": "<a token>"}` to let the client in, or `401` to refuse it.

The same check guards the relay. The app sends the same auth material to both (see `STARTER_AUTH_MATERIAL` below).

Three things to know before you turn it on:

- **The auth material is not a secret.** It is compiled into an app that anyone can download, so anyone can read it out. Use it to tell your app's traffic from other traffic and to limit rates, not to keep people out.
- **Your hook becomes part of every app start.** A Holochain 0.7.1 conductor that carries auth material and cannot authenticate does not start. The Starter covers the case where the bootstrap server does not answer at all (it starts without the auth and restarts with it later), but a hook that is down behind a healthy bootstrap server stops your users' apps from reaching the network.
- **An always-on node needs the same auth material** in its own config.

The hook protocol is described at <https://github.com/holochain/sbd/blob/main/spec-auth.md>.

## 2. An always-on node

An always-on node is a peer on your board's network that stays online. It is on the **same network** as your users only when all of these match the released app:

- the same board DNA (the packed file your release ships, `src-tauri/resources/starter_board_v1_happ.happ`),
- the same network seed (the app installs the board with `BOARD_NETWORK` from `src-tauri/src/names.rs`, which is your app's identifier),
- the same bootstrap server, relay and auth material.

### The simple way: your app, left running

Every running copy of your app holds the board and serves it to the others. So the simplest always-on node is the app itself:

1. Take a computer that stays on and has a desktop session: a spare desktop or a mini PC.
2. Install your **released** build on it (the one built with your settings below), and open it.
3. Turn off sleep and hibernation for that computer.
4. Make the app start again after a reboot or a power cut, with your system's own "open at login" setting. The Starter does not add itself to the login items.

It does not need to be signed in. The board is installed at the first start, and reading and holding it needs no identity.

The app looks after its own conductor: it restarts it when it stops, and restarts it at a quiet moment when it holds too much memory. That is why this way needs the least from you.

### The server way: a plain conductor

The Starter has no headless node program. If you want a node on a server with no screen, run the Holochain conductor directly and install your board on it. The steps below are assembled from the conductor's own options and from how Flowsta's public node program configures its conductors. Try them against a test build of your app before you depend on them.

**The binary.** Use the same conductor your app ships: `scripts/fetch-holochain.sh` names the release, and `.github/holochain-sidecars.sha256` has the hash to check your download against. For a Linux server that is the file `holochain-x86_64-unknown-linux-gnu` from the release `holochain-0.7.1-flowsta.4` at <https://github.com/WeAreFlowsta/holochain-build/releases>.

**The config.** Save as `conductor-config.yaml`:

```yaml
admin_interfaces:
- driver:
    type: websocket
    port: 4600
    danger_bind_addr: null
    allowed_origins: "board-node"

network:
  bootstrap_url: "https://bootstrap.example.org"
  relay_url: "https://bootstrap.example.org./"
  request_timeout_s: 60
  # What the app itself runs with: a peer that does not answer is given up
  # on after 15 seconds, not the default 60.
  advanced:
    irohTransport:
      connectTimeoutS: 15
  # Only if your bootstrap server has an authentication hook:
  # base64_auth_material_bootstrap: "<the same value as STARTER_AUTH_MATERIAL>"
  # base64_auth_material_relay: "<the same value>"

data_root_path: "/var/lib/board-node/holochain"

keystore:
  type: lair_server_in_proc
  lair_root: "/var/lib/board-node/holochain/ks"

db_sync_level: Normal
```

The admin interface listens on this machine only, and answers only a client that presents the origin `board-node`.

If you run the **official** Holochain 0.7.1 binary instead of the build above, add a gossip cap under `network:` (lesson 8 in [WHAT_WE_LEARNED.md](WHAT_WE_LEARNED.md) says why):

```yaml
  advanced:
    k2Gossip:
      maxGossipOpBytes: 1048576
      maxRequestGossipOpBytes: 1048576
```

**Start it.** The key store is encrypted with a passphrase, which the conductor reads from standard input:

```bash
holochain --piped -c conductor-config.yaml < passphrase.txt
```

It prints `Conductor ready.` when the admin interface is up. Keep the passphrase file readable by the service's user only, and keep it: without it the key store cannot be opened again.

**Install your board, once.** On the same machine, in a folder with a copy of your `.happ` file:

```bash
npm install @holochain/client@0.21.1
```

```js
// install-board.mjs
import { readFileSync } from "node:fs";
import { AdminWebsocket } from "@holochain/client";

const APP_ID = "board";
const admin = await AdminWebsocket.connect({
  url: new URL("ws://localhost:4600"),
  wsClientOptions: { origin: "board-node" },
});

const apps = await admin.listApps({});
if (!apps.some((a) => a.installed_app_id === APP_ID)) {
  await admin.installApp({
    agent_key: await admin.generateAgentPubKey(),
    installed_app_id: APP_ID,
    source: { type: "bytes", value: readFileSync("starter_board_v1_happ.happ") },
    // BOARD_NETWORK in src-tauri/src/names.rs: your app's identifier.
    network_seed: "org.example.myapp",
  });
}
await admin.enableApp({ installed_app_id: APP_ID });

for (const a of await admin.listApps({})) {
  console.log(a.installed_app_id, JSON.stringify(a.status));
}
console.log("peer store entries:", (await admin.agentInfo({ dna_hashes: null })).length);
process.exit(0);
```

```bash
node install-board.mjs
```

Then restart the conductor once: Holochain 0.7.1 keeps a large amount of memory after an install until it restarts.

Run the script again a few minutes later. `peer store entries` counts the peers the conductor knows, itself included. With one copy of your app online it should be 2 or more. If it stays at 1, the node is alone: check the bootstrap address, the auth material and, most of all, the network seed. A wrong seed gives no error. It gives a different, empty network.

**Keep it running.** Run the conductor under your system's service manager so it starts at boot and starts again if it exits. Two things the app does for itself that you must arrange here:

- **Memory.** A Holochain 0.7.1 conductor's memory grows while it runs, and a restart gives it back. Restart the node on a schedule, at an hour when few people write. The app restarts its own conductor above 1 GiB; use that as your guide.
- **After a bootstrap outage.** A conductor whose registrations were refused during an outage of more than a few minutes can stay unregistered after the server is back. If the node's log keeps repeating `Bootstrap PUT returned HTTP error`, restart the conductor.

### Rules for any always-on node

- **Each node has its own key.** Never copy one node's data folder to a second machine. Two conductors with the same key on one network do not sync with each other, and nothing tells you.
- **Do not wipe a node that may hold notes nobody else holds.** In a small network your node can be the only peer that has a given note. To replace a node, start the new one beside it, give the two time to sync, and only then stop the old one.
- **Run more than one when people start to depend on the app.** One node is one power cut away from the empty board described above. A second one in another place costs little.
- **Keep its clock right.** The bootstrap server refuses a registration whose time is more than three minutes from its own.

### About Flowsta's node program

Flowsta publishes the program its own always-on nodes run, at <https://github.com/WeAreFlowsta/flowsta-dht-node>. It is built for the Flowsta network: it takes the list of what to run from a manifest that Flowsta signs and Flowsta's API serves. A fork cannot point it at its own DNA as it is. It is good reading for how a node can update itself safely, and its bootstrap role is the same server as in section 1.

## 3. Point the app at them

Read when the app is **built** and compiled into it:

| Setting | Value | When unset |
|---|---|---|
| `STARTER_BOOTSTRAP_URL` | `https://bootstrap.example.org` | the public Holochain test server |
| `STARTER_AUTH_MATERIAL` | standard base64, with `=` padding, of the bytes your authentication hook expects | no auth is sent |
| `STARTER_RELAY_URL` | only when your relay is on another host than your bootstrap server | the bootstrap server's own host |

**One address is enough.** The bootstrap server is the relay too, so the app takes the relay's address from `STARTER_BOOTSTRAP_URL`. Peers write a relay's address with a dot after the hostname and a slash at the end (`https://bootstrap.example.org./`); the app makes that form itself. If you do set `STARTER_RELAY_URL`, write it exactly so.

**Where to set them:**

- On your own machine: copy `.env.example` to `.env` and fill them in. `src-tauri/build.rs` reads that file.
- In the release workflow: as repository secrets with the same names (RELEASING.md has the table). The workflow passes them to the build as environment variables.

The environment wins over `.env`. An empty value counts as unset.

Because the values are compiled in, an installed copy keeps the servers it was built with. Moving to another hostname later means a new release, and copies that have not updated yet stay on the old one. Choose a hostname you can keep, and move the server behind it instead.

### The auth material

Skip this unless your bootstrap server runs with an authentication hook.

`STARTER_AUTH_MATERIAL` is the bytes your hook expects, encoded as **standard base64 with its `=` padding**. Standard means the alphabet with `+` and `/`. The URL-safe alphabet (`-` and `_`) and values with the padding removed are both refused.

On Linux:

```bash
printf '%s' 'the bytes your hook expects' | base64 -w0
```

Why the rule is strict: the conductor decodes the value with a strict standard decoder, and a value it cannot decode stops every start of the app. (The comment on this field in Holochain 0.7.1's own config describes another encoding. The code is what counts, and the code wants padded standard base64.) `build.rs` checks the value and stops the build with `STARTER_AUTH_MATERIAL is not padded standard base64` instead of letting such an app ship.

The app sends the same value to the bootstrap server and to the relay.

## 4. Check that it works

Use two computers, each with its own Flowsta Vault and identity, on two different internet connections if you can. That is what your users will have.

1. Build the app with your settings and install that build on both. Both must be the same app: the same identifier and the same settings.
2. Open it on both and wait for the board.
3. Sign in on computer A and write a note on the board.
4. Look at the board on computer B. The note should appear within a few minutes. The first read after a start is the slow one. Later notes arrive faster.
5. Write a note on B and see it on A.
6. Now the test the always-on node exists for: quit the app on A. On B, write a note, wait a minute, and quit. Start the app on A. With an always-on node running, A shows B's note. Without one, it cannot.

### What the log says

The log file is named after your app's slug (`LOG_FILE_NAME` in `src-tauri/src/names.rs`; `starter.log` before you rename the app):

- Linux: `~/.local/share/<your identifier>/logs/`
- macOS: `~/Library/Logs/<your app's name>/`
- Windows: `%LOCALAPPDATA%\<your identifier>\logs\`

A healthy start writes:

```
Holochain ready (admin 4488, app 51234; this device's key uhCAk...; my notes not set up on this device yet)
```

After that, the lines that begin `[rendezvous]` are about your bootstrap server. The app checks once a minute that this device is listed there, and it only writes a line when something changes. Silence is good.

| Line | Meaning |
|---|---|
| `[rendezvous] handed the conductor N note(s) of other devices it had not heard of` | Good: the server listed peers and the app passed them to the conductor. |
| `no rendezvous answers (https://...): starting without its auth` | Your bootstrap server did not answer its health check at the start. Only with auth material set. The app works locally and restarts Holochain when the server answers. |
| `[network] the rendezvous answers again: restarting Holochain with its auth` | The follow-up to the line above. |
| `[rendezvous] no rendezvous answered (1 tried) - the other devices cannot find this one until one does` | The server is unreachable from this computer now. Run the `curl` check from section 1 on the same computer. |
| `[rendezvous] registered N agent note(s) on https://... ourselves - the conductor's own registration did not reach the server` | The conductor's own registration stalled and the app covered for it. Now and then is fine. All the time means the server is refusing registrations: read its log. |
| `[rendezvous] another install is running as this conductor's key` | Two machines run with the same device key (a copied data folder). They will not sync until one has its own. |
| `[start] the first attempt failed: ...` | Holochain did not start at the first try, and the rest of the line is the reason. A conductor that carries auth material and cannot authenticate with your server does not start, so look here first after you turn on an authentication hook. |

### If the two computers do not see each other

Work through these in order:

1. **The server.** The `curl` check from each computer.
2. **The same build.** Both installed from the same release, so both carry the same settings and the same identifier. A copy started with `npm run tauri dev` uses your `.env`, which may differ from the release's secrets.
3. **Time.** Give a freshly started pair a few minutes.
4. **The relay address.** If you set `STARTER_RELAY_URL`, it has the dot and the slash.
5. **The firewall.** TCP 443 and UDP 7842 open on the VM.
6. **The server's log.** `docker logs bootstrap --tail 200` on the VM.
