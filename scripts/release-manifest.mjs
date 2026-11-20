#!/usr/bin/env node
// Build, sign and publish the release manifest for a finished release.
// RELEASING.md walks through it; this is the step after the release workflow,
// and until it is done no installed copy takes the update.
//
// An installed app updates only to a release whose manifest was signed by one
// of the Flowsta identities compiled into it (RELEASE_SIGNERS in
// src-tauri/src/names.rs). The manifest names the version, the channel and
// every installer and updater file with its size and SHA-256.
//
// What this does, for the release at <tag>:
//   1. reads the release from GitHub: its files with GitHub's own SHA-256
//      digests, and the sidecar hashes the workflow published;
//   2. builds the manifest and prints it;
//   3. asks your running Flowsta Vault to sign it. The Vault shows the app,
//      the version, the channel and every file, and signs only when you
//      approve. The signature is checked here against RELEASE_SIGNERS;
//   4. publishes the channel's two files (latest.json, release-manifest.json)
//      to a fixed pre-release, `<prefix>-beta` or `<prefix>-stable`, which
//      installed copies read. The macOS update files, every updater
//      signature and the kit hashes move to `<prefix>-updates`, so the page
//      people download from shows the installers and SHA256SUMS.txt only.
//
// Usage, from the repository root:
//   node scripts/release-manifest.mjs <tag> [--dry-run] [--rollout 100] [--from <version>]
//        [--sequence N] [--allow-older] [--no-upload] [--vault URL]
//   --dry-run: print the manifest and its statement; sign and publish nothing.
//
// The app's name, identifier, repository, channel prefix and signers are read
// from the repository (tauri.conf.json and names.rs), so a renamed app needs
// no change here.
//
// The Vault signs only for an app it is connected to. This tool connects as
// YOUR app, from the origin below: add that origin to your app's registered
// origins at dev.flowsta.com, and put the app's client id in .env
// (VITE_FLOWSTA_CLIENT_ID) or in FLOWSTA_RELEASE_CLIENT_ID. The first run
// asks you to approve the connection in your Vault. Needs the GitHub CLI
// (`gh auth login`) or a GITHUB_TOKEN that may write releases.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import blake from 'blakejs';

/** A POST to the running Vault that waits as long as its approval dialog
 *  does (fetch gives up after five minutes; the dialog allows ten). */
function postToVault(url, origin, payload, waitMs = 11 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Origin: origin },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    req.setTimeout(waitMs, () => req.destroy(new Error(`no answer from the Vault in ${Math.round(waitMs / 60000)} minutes`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** Canonical JSON: the one byte sequence a JSON value has (keys sorted, no
 *  whitespace), so a signature over it means the same to the signer and
 *  every verifier. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** A Holochain agent key from 32 key bytes, as text: the type prefix, the
 *  key, and four location bytes (a 16-byte BLAKE2b of the key, folded). */
function agentKeyText(raw32) {
  const hash = blake.blake2b(raw32, null, 16);
  const location = Buffer.alloc(4);
  for (let i = 0; i < 16; i++) location[i % 4] ^= hash[i];
  return `u${Buffer.concat([Buffer.from([0x84, 0x20, 0x24]), raw32, location]).toString('base64url')}`;
}

// ---- The app, from the repository ------------------------------------------
if (!fs.existsSync('src-tauri/src/names.rs')) {
  console.error('release-manifest: run it from the repository root (src-tauri/src/names.rs not found)');
  process.exit(2);
}
const namesRs = fs.readFileSync('src-tauri/src/names.rs', 'utf8');
const nameOf = (key) => {
  const m = new RegExp(`pub const ${key}: &str = "([^"]+)";`).exec(namesRs);
  if (!m) throw new Error(`names.rs has no ${key}`);
  return m[1];
};
const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const NAME = conf.productName;
const APP = conf.identifier;
const REPO = (/github\.com\/([^/]+\/[^/]+)\/releases/.exec(nameOf('RELEASES_URL')) || [])[1];
if (!REPO) throw new Error('RELEASES_URL in names.rs is not a GitHub releases address');
const PREFIX = nameOf('CHANNEL_PREFIX');
const cfg = { tagPrefix: 'v' };
const [BETA_TAG, STABLE_TAG, UPDATES_TAG] = [`${PREFIX}-beta`, `${PREFIX}-stable`, `${PREFIX}-updates`];
const LINES = ['holochain-0.7'];
const SIGNERS = [...(/pub const RELEASE_SIGNERS: &\[&str\] = &\[([^\]]*)\];/.exec(namesRs) || ['', ''])[1].matchAll(/"(did:flowsta:u[A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
if (SIGNERS.length === 0) throw new Error('RELEASE_SIGNERS in names.rs lists no Flowsta identity');
// The origin this tool presents to the Vault: one of your app's registered
// origins (dev.flowsta.com).
const ORIGIN = 'http://localhost:7331';
const MAX_SEQUENCE_JUMP = 100;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const tag = args[0];
if (!tag || tag.startsWith('--')) {
  console.error('usage: node scripts/release-manifest.mjs <tag> [--dry-run] [--rollout 100] [--from <version>] [--sequence N] [--allow-older] [--no-upload] [--vault URL]');
  process.exit(2);
}
if (!tag.startsWith(cfg.tagPrefix)) throw new Error(`release tags start with ${cfg.tagPrefix} (v1.2.0, v1.2.0-beta.1)`);
const dryRun = flag('dry-run');
const upload = !flag('no-upload') && !dryRun;
const VAULT = opt('vault', 'http://localhost:27777').replace(/\/$/, '');
const configDir = path.join(os.homedir(), '.config', PREFIX);

// ---- GitHub ---------------------------------------------------------------
let token = process.env.GITHUB_TOKEN;
const authToken = () => (token ||= execFileSync('gh', ['auth', 'token']).toString().trim());
const gh = async (url, init = {}) => {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'release-manifest-tool', ...(init.headers || {}) };
  if (init.auth !== false) headers.Authorization = `Bearer ${authToken()}`;
  const r = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, { ...init, headers });
  if (!r.ok && r.status !== 404) throw new Error(`${init.method || 'GET'} ${url}: ${r.status} ${await r.text()}`);
  return r;
};

const release = await (await gh(`/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`)).json();
if (!release.id) throw new Error(`no release ${tag} in ${REPO}`);
// A draft's download links are temporary untagged-... addresses.
if (release.draft) throw new Error(`${tag} is still a draft: publish it first`);
const version = tag.slice(cfg.tagPrefix.length);
const channel = release.prerelease ? 'beta' : 'stable';
// Each channel's two updater files live on one fixed pre-release (never the
// "latest" release), so no release page carries them.
const CHANNEL_TAG = channel === 'beta' ? BETA_TAG : STABLE_TAG;
const channelUrl = (tagName, name) => `https://github.com/${REPO}/releases/download/${tagName}/${name}`;

// The installers and updater files, by what their names say. An updater file's
// .sig and the build's own records are not listed.
const ARM = /aarch64|arm64|apple-silicon/i;
const fileKind = (name) => {
  if (name.endsWith('.sig')) return null;
  const arch = ARM.test(name) ? 'aarch64' : 'x86_64';
  if (name.endsWith('.app.tar.gz')) return [`darwin-${arch}`, 'app-tarball'];
  if (name.endsWith('.dmg')) return [`darwin-${arch}`, 'dmg'];
  if (/setup\.exe$/i.test(name)) return ['windows-x86_64', 'nsis'];
  if (name.endsWith('.msi')) return ['windows-x86_64', 'msi'];
  if (name.endsWith('.deb')) return ['linux-x86_64', 'deb'];
  if (name.endsWith('.rpm')) return ['linux-x86_64', 'rpm'];
  return null;
};
const sha256Of = async (asset) => {
  if (asset.digest?.startsWith('sha256:')) return asset.digest.slice(7);
  // No digest from GitHub: hash the download.
  const r = await fetch(asset.browser_download_url);
  if (!r.ok) throw new Error(`download ${asset.name}: ${r.status}`);
  return createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
};
// The macOS update files and every .sig leave the download page: the
// updater needs them, people downloading by hand do not.
const movesToUpdates = (name) => /\.app\.tar\.gz$|\.sig$/.test(name);
// The build's sidecar hashes (read below into the manifest) are kept beside
// the update files under this version's name; the version file the release
// workflow wrote goes to the channel release.
const KIT = /^kit-hashes-(.+)\.json$/;
const keptKitName = (name) => name.replace(KIT, `kit-hashes-${version}-$1.json`);
// The parts the release needs beside the app (an optional engine, a helper
// program), written by the app's build as parts.json: read below into the
// manifest and kept beside the update files under this version's name.
const PARTS_FILE = 'parts.json';
const keptPartsName = `parts-${version}.json`;
const updatesUrl = (name) => `https://github.com/${REPO}/releases/download/${UPDATES_TAG}/${encodeURIComponent(name)}`;
const toMove = release.assets.filter((a) => movesToUpdates(a.name));
const kitOnPage = release.assets.filter((a) => KIT.test(a.name));
const partsOnPage = release.assets.filter((a) => a.name === PARTS_FILE);
// The update-files release as it is; this version's files there were moved
// by an earlier run.
const updatesNow = await (await gh(`/repos/${REPO}/releases/tags/${UPDATES_TAG}`)).json();
const alreadyMoved = (updatesNow.assets || []).filter((a) => a.name.includes(`${version}-macOS-`) && !toMove.some((m) => m.name === a.name));
const files = [];
for (const asset of [...release.assets, ...alreadyMoved]) {
  const pk = fileKind(asset.name);
  if (!pk) continue;
  const url = movesToUpdates(asset.name) ? updatesUrl(asset.name) : asset.browser_download_url;
  files.push({ platform: pk[0], kind: pk[1], name: asset.name, url, size: asset.size, sha256: await sha256Of(asset) });
}
files.sort((a, b) => `${a.platform} ${a.kind}`.localeCompare(`${b.platform} ${b.kind}`));
if (files.length === 0) throw new Error(`${tag} has no installers or updater files`);

// The updater's version file must send each platform to one of these files
// at its published address, and each must download: links written while the
// release was a draft point at an untagged-... address that stops working.
const latestAsset = release.assets.find((a) => a.name === 'latest.json');
const latestFrom = latestAsset ? latestAsset.browser_download_url : channelUrl(CHANNEL_TAG, 'latest.json');
const latestRes = await fetch(latestFrom);
if (!latestRes.ok) {
  throw new Error(latestAsset ? `read ${latestFrom}: ${latestRes.status}` : `${tag} has no latest.json (the release workflow writes it) and ${CHANNEL_TAG} has none either (${latestRes.status})`);
}
const latestJson = JSON.parse(await latestRes.text());
if (latestJson.version !== version) throw new Error(`${tag}'s latest.json is for ${latestJson.version}, not ${version}`);
// A link to a file that moves now points at its copy (a second run finds it
// moved already).
const releaseUrl = (name) => `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`;
for (const p of Object.values(latestJson.platforms ?? {})) {
  const moved = toMove.find((a) => p.url === a.browser_download_url || p.url === releaseUrl(a.name));
  if (moved) p.url = updatesUrl(moved.name);
}
const latestBody = JSON.stringify(latestJson, null, 2) + '\n';
const fileUrls = new Set(files.map((f) => f.url));
for (const [key, p] of Object.entries(latestJson.platforms ?? {})) {
  if (!fileUrls.has(p.url)) throw new Error(`${tag}'s latest.json sends ${key} to ${p.url}, not one of this release's files`);
}

// ---- The macOS update files copied to the update-files pre-release (never
// "latest": stable installs read the newest normal release). Each copy must
// match its original's digest. A dry run copies nothing.
const download = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
let updatesRelease = null;
if ((toMove.length || kitOnPage.length || partsOnPage.length) && !dryRun) {
  updatesRelease = updatesNow;
  if (!updatesRelease.id) {
    updatesRelease = await (await gh(`/repos/${REPO}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: UPDATES_TAG, name: `Update files (for the ${NAME} updater)`, body: `Holds the macOS update files the ${NAME} updater downloads, every update file's signature, and each release's kit hashes. The installers are on each release's own page.`, prerelease: true }),
    })).json();
  }
  for (const a of toMove) {
    const want = await sha256Of(a);
    const have = (updatesRelease.assets || []).find((x) => x.name === a.name);
    if (have && (await sha256Of(have)) === want) continue;
    if (have) await gh(`/repos/${REPO}/releases/assets/${have.id}`, { method: 'DELETE' });
    const bytes = await download(a.browser_download_url);
    if (createHash('sha256').update(bytes).digest('hex') !== want) throw new Error(`${a.name} downloaded with another digest`);
    const up = await (await gh(`https://uploads.github.com/repos/${REPO}/releases/${updatesRelease.id}/assets?name=${encodeURIComponent(a.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })).json();
    if (up.digest && up.digest !== `sha256:${want}`) throw new Error(`the copy of ${a.name} has another digest (${up.digest})`);
    console.log(`copied ${a.name} to ${UPDATES_TAG}`);
  }
} else if (toMove.length) {
  for (const a of toMove) console.log(`--dry-run: would copy ${a.name} to ${UPDATES_TAG}`);
}

// Every platform's file must download at the address the version file names
// (links written while a release is a draft stop working at publish).
for (const [key, p] of Object.entries(latestJson.platforms ?? {})) {
  const moving = dryRun && toMove.find((a) => p.url === updatesUrl(a.name));
  const url = moving ? moving.browser_download_url : p.url;
  const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  await r.body?.cancel();
  if (!r.ok) throw new Error(`${tag}'s latest.json sends ${key} to ${url}: ${r.status}`);
}

const kit = [];
const kitKept = (updatesNow.assets || []).filter((a) => a.name.startsWith(`kit-hashes-${version}-`));
for (const asset of kitOnPage.length ? kitOnPage : kitKept) {
  const r = await fetch(asset.browser_download_url);
  if (!r.ok) throw new Error(`download ${asset.name}: ${r.status}`);
  for (const k of await r.json()) kit.push({ line: k.line, target: k.target, sidecar: k.sidecar, sha256: k.sha256 });
}
kit.sort((a, b) => `${a.target} ${a.sidecar}`.localeCompare(`${b.target} ${b.sidecar}`));

// The parts: a name, a target, a version, and the file's size and hash. No
// address: the app that knows a part knows where its files are published.
const parts = [];
const partsKept = (updatesNow.assets || []).filter((a) => a.name === keptPartsName);
const plainWord = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) && !v.includes('..');
for (const asset of partsOnPage.length ? partsOnPage : partsKept) {
  const r = await fetch(asset.browser_download_url);
  if (!r.ok) throw new Error(`download ${asset.name}: ${r.status}`);
  const listed = await r.json();
  if (!Array.isArray(listed)) throw new Error(`${asset.name} is not a list`);
  for (const [i, p] of listed.entries()) {
    if (!plainWord(p.name) || !plainWord(p.target) || !plainWord(p.version) || !Number.isInteger(p.size) || p.size < 1 || !/^[0-9a-f]{64}$/.test(p.sha256 ?? '')) {
      throw new Error(`${asset.name}[${i}] needs a name, a target and a version in plain words, a size and a sha256`);
    }
    parts.push({ name: p.name, target: p.target, version: p.version, size: p.size, sha256: p.sha256 });
  }
}
parts.sort((a, b) => `${a.name} ${a.target}`.localeCompare(`${b.name} ${b.target}`));
if (new Set(parts.map((p) => `${p.name} ${p.target}`)).size !== parts.length) throw new Error('parts.json names the same part twice for one target');

// ---- The sequence: one above the last this channel published or this machine signed.
const lastSignedPath = path.join(configDir, 'release-manifests', `${APP}-${channel}.json`);
const lastSigned = fs.existsSync(lastSignedPath) ? JSON.parse(fs.readFileSync(lastSignedPath, 'utf8')).sequence : 0;
const channelManifestUrl = channelUrl(CHANNEL_TAG, 'release-manifest.json');
const published = await fetch(channelManifestUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
// ---- The version must sort above the one the channel holds, by the rule the
// installed updater uses (semver). A pre-release part that mixes letters and
// digits is compared as text: "beta10" sorts BELOW "beta9", so no install on
// beta9 would ever take it. Write the number as its own part ("beta.10",
// "rc.1").
function semverCompare(a, b) {
  const split = (v) => { const [core, ...pre] = v.split('+')[0].split('-'); return [core.split('.').map(Number), pre.length ? pre.join('-').split('.') : []]; };
  const [ca, pa] = split(a); const [cb, pb] = split(b);
  for (let i = 0; i < 3; i++) if ((ca[i] || 0) !== (cb[i] || 0)) return (ca[i] || 0) < (cb[i] || 0) ? -1 : 1;
  if (!pa.length || !pb.length) return pa.length === pb.length ? 0 : pa.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]); const nb = /^\d+$/.test(pb[i]);
    if (na && nb) { if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
for (const [x, y, want] of [['1.8.0-beta10', '1.8.0-beta9', -1], ['1.8.0-beta.10', '1.8.0-beta.9', 1], ['1.8.0-rc.1', '1.8.0-beta9', 1], ['1.8.0', '1.8.0-rc.1', 1], ['1.8.1', '1.8.0', 1], ['0.6.0-beta.9', '0.6.0-beta.9', 0]]) {
  if (semverCompare(x, y) !== want) throw new Error(`the version comparison is wrong for ${x} and ${y}`);
}
const channelVersion = published?.app === APP && published?.channel === channel ? published.version : null;
if (channelVersion && channelVersion !== version && semverCompare(version, channelVersion) <= 0 && !args.includes('--allow-older')) {
  throw new Error(`${version} does not sort above ${channelVersion}, which the ${channel} channel holds: an install on ${channelVersion} would never take it. A pre-release number must be a part of its own ("beta.10", not "beta10"). Pass --allow-older only to move a channel back on purpose.`);
}

let sequence = Number(opt('sequence', 0));
if (!sequence) {
  sequence = Math.max(lastSigned, published?.app === APP && published?.channel === channel ? published.sequence : 0) + 1;
  if (sequence > lastSigned + MAX_SEQUENCE_JUMP) throw new Error(`the published manifest says the next sequence is ${sequence} but the last one signed here was ${lastSigned}; pass --sequence to confirm`);
}
if (!Number.isInteger(sequence) || sequence < 1 || sequence > 2 ** 31 - 1) throw new Error(`sequence ${sequence} is out of range`);

const percent = Number(opt('rollout', 100));
if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error('--rollout must be a whole number from 0 to 100');
const manifest = {
  v: 1,
  app: APP,
  channel,
  sequence,
  issued_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  version,
  notes_url: release.html_url,
  holochain: { lines: LINES, changes_line: false },
  rollout: { percent },
  files,
  kit,
};
if (opt('from')) manifest.from_version = opt('from');
// Only a release that names parts carries the member: every other manifest
// is the same bytes as before the member existed.
if (parts.length) manifest.parts = parts;

// ---- The statement: what is signed. Canonical JSON (sorted keys, no
// whitespace), the same bytes the Vault and the app compute. Integers only.
const nonInteger = (v) => (Array.isArray(v) ? v.some(nonInteger) : v && typeof v === 'object' ? Object.values(v).some(nonInteger) : typeof v === 'number' && !Number.isInteger(v));
if (nonInteger(manifest)) throw new Error('a release manifest carries whole numbers only');
const canonical = canonicalJson;
const statement = `flowsta-release-manifest:v1:${APP}:${channel}:${sequence}:${createHash('sha256').update(canonical(manifest), 'utf8').digest('hex')}`;

console.log(`${APP} ${version} on ${channel}, sequence ${sequence}, rollout ${percent} %`);
for (const f of files) console.log(`  ${f.platform.padEnd(15)} ${f.kind.padEnd(12)} ${String(f.size).padStart(10)}  ${f.sha256}  ${f.name}`);
for (const k of kit) console.log(`  kit ${k.target.padEnd(28)} ${k.sidecar.padEnd(24)} ${k.sha256}`);
for (const p of parts) console.log(`  part ${p.name.padEnd(16)} ${p.target.padEnd(28)} ${p.version.padEnd(10)} ${String(p.size).padStart(10)}  ${p.sha256}`);
console.log(`statement ${statement}`);
if (dryRun) {
  console.log('\n--dry-run: nothing signed or uploaded');
  process.exit(0);
}

// ---- The Vault signs, for an app it is connected to. This tool has a key
// of its own (made at its first run, kept in your config folder) and
// connects as your app from ORIGIN.
const status = await fetch(`${VAULT}/status`).then((r) => r.json()).catch(() => null);
if (!status) throw new Error(`no Vault at ${VAULT}: open Flowsta Vault and unlock it`);
if (!status.unlocked) throw new Error('the Vault is locked: unlock it first');
const toolKeyFile = process.env.RELEASE_TOOL_KEY || path.join(configDir, 'release-tool.key');
if (!fs.existsSync(toolKeyFile)) {
  fs.mkdirSync(path.dirname(toolKeyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(toolKeyFile, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
}
const appKey = agentKeyText(createPublicKey(createPrivateKey(fs.readFileSync(toolKeyFile, 'utf8'))).export({ format: 'der', type: 'spki' }).subarray(-32));
const linked = await fetch(`${VAULT}/link-status?app_agent_pub_key=${encodeURIComponent(appKey)}`, { headers: { Origin: ORIGIN } }).then((r) => r.json()).catch(() => ({ linked: false }));
if (!linked.linked) {
  const fromEnvFile = fs.existsSync('.env') ? (/^\s*VITE_FLOWSTA_CLIENT_ID\s*=\s*["']?([^"'\s]+)/m.exec(fs.readFileSync('.env', 'utf8')) || [])[1] : undefined;
  const clientId = process.env.FLOWSTA_RELEASE_CLIENT_ID || process.env.VITE_FLOWSTA_CLIENT_ID || fromEnvFile;
  if (!clientId) throw new Error('first run: put your app\'s client id in .env (VITE_FLOWSTA_CLIENT_ID) or in FLOWSTA_RELEASE_CLIENT_ID');
  console.log('connecting this tool to your Vault (approve it there within a minute)...');
  const r = await postToVault(`${VAULT}/link-identity`, ORIGIN, { app_name: `${NAME} (release tool)`, client_id: clientId, app_agent_pub_key: appKey });
  if (r.status === 408) throw new Error('nobody answered the connect request in your Vault within its time limit; nothing was signed. Run this again and approve it there');
  if (!r.ok) throw new Error(`the Vault did not connect the tool: ${r.status} ${await r.text()} (is ${ORIGIN} one of your app's registered origins at dev.flowsta.com?)`);
}
console.log('asking the Vault to sign (approve it there within ten minutes; check the version, channel and hashes against the lines above)...');
const signRes = await postToVault(`${VAULT}/sign-release-manifest`, ORIGIN, { manifest });
if (!signRes.ok) throw new Error(`sign refused: ${signRes.status} ${await signRes.text()}`);
const signed = await signRes.json();
if (signed.statement !== statement) throw new Error(`the Vault signed a different statement:\n  vault ${signed.statement}\n  here  ${statement}`);
const sig = Buffer.from(signed.signature, 'base64');
// The signature must be one an installed copy accepts: an Ed25519
// signature over the statement by one of RELEASE_SIGNERS.
const verifiesAs = (did) => {
  const raw = Buffer.from(did.replace(/^did:flowsta:u/, ''), 'base64url').subarray(3, 35);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  return sig.length === 64 && cryptoVerify(null, Buffer.from(statement, 'utf8'), key, sig);
};
const signer = SIGNERS.find(verifiesAs);
if (!signer) {
  throw new Error(`the signature is not by an identity in RELEASE_SIGNERS (names.rs), so no installed copy would accept it. The Vault signed as ${signed.signer_did}: unlock the Vault as your release identity, or list this one in RELEASE_SIGNERS and release again.`);
}
manifest.signature = { signer, sig: sig.toString('base64'), statement };
const body = JSON.stringify(manifest, null, 2) + '\n';
fs.mkdirSync(path.dirname(lastSignedPath), { recursive: true });
fs.writeFileSync(lastSignedPath, body);
console.log(`signed and verified as ${signer}; written ${lastSignedPath}`);
if (!upload) process.exit(0);

// ---- Upload: the channel's fixed pre-release, which installs read.
const replaceAsset = async (rel, name, data, type) => {
  for (const a of rel.assets.filter((x) => x.name === name)) await gh(`/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
  await gh(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body: data });
};
let channelRelease = await (await gh(`/repos/${REPO}/releases/tags/${CHANNEL_TAG}`)).json();
if (!channelRelease.id) {
  const label = channel === 'beta' ? 'Beta' : 'Stable';
  channelRelease = await (await gh(`/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: CHANNEL_TAG, name: `${label} channel (for the ${NAME} updater)`, body: `Holds the ${channel} channel's two updater files. The installers are on each release's own page.`, prerelease: true }),
  })).json();
}
await replaceAsset(channelRelease, 'latest.json', latestBody, 'application/json');
await replaceAsset(channelRelease, 'release-manifest.json', body, 'application/json');
console.log(`${channel} channel (${CHANNEL_TAG}) now points at ${version}`);

// The build's kit hashes, kept beside the update files under this version's name.
if (kitOnPage.length) {
  const current = await (await gh(`/repos/${REPO}/releases/${updatesRelease.id}`)).json();
  for (const a of kitOnPage) await replaceAsset(current, keptKitName(a.name), await download(a.browser_download_url), 'application/json');
  console.log(`kept ${kitOnPage.length} kit hash file(s) in ${UPDATES_TAG}`);
}

// ...and its list of parts.
if (partsOnPage.length) {
  const current = await (await gh(`/repos/${REPO}/releases/${updatesRelease.id}`)).json();
  await replaceAsset(current, keptPartsName, await download(partsOnPage[0].browser_download_url), 'application/json');
  console.log(`kept the parts list in ${UPDATES_TAG}`);
}

// ---- The originals leave the download page, now that every version file
// names the copies. Then the update-files release keeps what either channel
// still points at (unread channel: nothing is removed).
const offPage = [...toMove, ...kitOnPage, ...partsOnPage, ...release.assets.filter((a) => a.name === 'latest.json' || a.name === 'release-manifest.json')];
for (const a of offPage) await gh(`/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
if (offPage.length) console.log(`removed ${offPage.length} updater file(s) from ${tag}'s page`);
if (updatesRelease) {
  // The other channel's version file, at its channel release; a stable
  // published before channel releases existed is read where it was.
  const read = (url) => fetch(url).then((r) => (r.status === 404 ? { platforms: {} } : r.ok ? r.json() : null)).catch(() => null);
  const otherTag = channel === 'beta' ? STABLE_TAG : BETA_TAG;
  const others = [await read(channelUrl(otherTag, 'latest.json'))];
  if (channel === 'beta') others.push(await read(`https://github.com/${REPO}/releases/latest/download/latest.json`));
  if (others.every(Boolean)) {
    const keep = new Set();
    for (const v of [latestJson, ...others]) {
      if (v.version) keep.add(`kit-hashes-${v.version}-`);
      if (v.version) keep.add(`parts-${v.version}.json`);
      for (const p of Object.values(v.platforms ?? {})) {
        const name = decodeURIComponent(String(p.url).split('/').pop());
        keep.add(name).add(`${name}.sig`);
      }
    }
    const kept = (name) => keep.has(name) || [...keep].some((k) => k.endsWith('-') && name.startsWith(k));
    const current = await (await gh(`/repos/${REPO}/releases/${updatesRelease.id}`)).json();
    for (const a of current.assets.filter((x) => !kept(x.name))) {
      await gh(`/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
      console.log(`removed ${a.name} from ${UPDATES_TAG} (no channel points at it)`);
    }
  }
}
