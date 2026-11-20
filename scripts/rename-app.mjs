#!/usr/bin/env node
// Give your app its own name, identifier and sidecar names (and, with
// --port, its own port) in every place that carries them. Run from the repository root:
//
//   node scripts/rename-app.mjs --name "My App" --identifier org.example.myapp \
//        --slug myapp --repo you/my-app [--port 4500] [--signer did:flowsta:...] [--dry-run]
//
//   --name        what people see (window title, dialogs, the Vault's name for the app)
//   --identifier  the bundle identifier, reverse-DNS. It names the data folder
//                 on every system and the board's network (so your app's
//                 board is its own, not the Starter's). It must not end in
//                 ".app": macOS shows a folder with that ending as a broken
//                 application.
//   --slug        lowercase letters, digits and dashes: the prefix of the two
//                 sidecars, the package and program name, the log file and
//                 the update channels
//   --repo        owner/name on GitHub: where your releases are published
//   --port        the conductor's admin port (default: keep the one in names.rs)
//   --signer      the Flowsta identity your releases are signed with
//                 (did:flowsta:uhCAk...). Without it the app is built with
//                 no release signer and does not update itself: add yours
//                 to RELEASE_SIGNERS in names.rs before your first release.
//
// What it changes: src-tauri/src/names.rs (the one place the Rust code reads
// its names from), src/lib/app.ts (the page's copy of the name),
// src-tauri/tauri.conf.json, src-tauri/Cargo.toml, package.json, and the
// sidecar names, identifier and program name in the scripts, the UI suite
// and the workflows.
//
// What it leaves alone on purpose: the hApp and DNA names (`starter_board_v1`,
// `starter_my_notes_v1`) and the `STARTER_...` names of the test settings.
// They are internal ids no person sees; changing a hApp's name after a
// release would strand the data installed under it.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : [])),
);
const fail = (why) => { console.error(`rename-app: ${why}`); process.exit(1); };
const dry = args["dry-run"] === true;
const name = args.name, identifier = args.identifier, slug = args.slug, repo = args.repo;
if (typeof name !== "string" || !name.trim()) fail('--name "My App" is needed');
if (/["\\]/.test(name)) fail("--name must not hold a quote or a backslash");
if (typeof identifier !== "string" || !/^[a-z0-9]+(\.[a-z0-9-]+){2,}$/i.test(identifier)) fail("--identifier must be reverse-DNS with at least three parts, like org.example.myapp");
if (/\.app$/i.test(identifier)) fail('--identifier must not end in ".app" (macOS shows such a data folder as a broken application)');
if (typeof slug !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(slug)) fail("--slug must be lowercase letters, digits and dashes, starting with a letter");
if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail("--repo must be owner/name, the GitHub repository your releases are published in");
const signer = args.signer === undefined ? null : args.signer;
if (signer !== null && !/^did:flowsta:u[A-Za-z0-9_-]{52}$/.test(String(signer))) fail("--signer must be a Flowsta identity, like did:flowsta:uhCAk...");
const port = args.port === undefined ? null : Number(args.port);
if (port !== null && !(Number.isInteger(port) && port >= 1024 && port <= 65000)) fail("--port must be a port number between 1024 and 65000");

if (!existsSync("src-tauri/src/names.rs")) fail("run it from the repository root (src-tauri/src/names.rs not found)");
const names = readFileSync("src-tauri/src/names.rs", "utf8");
const now = (key) => {
  const m = new RegExp(`pub const ${key}: (?:&str|u16) = "?([^";]+)"?;`).exec(names);
  if (!m) fail(`names.rs has no ${key}`);
  return m[1];
};
const old = { name: now("APP_NAME"), identifier: now("APP_IDENTIFIER"), lair: now("LAIR"), conductor: now("CONDUCTOR"), port: now("ADMIN_PORT") };
const oldSlug = old.lair.replace(/-lair-keystore$/, "");
const next = {
  name: name.trim(), identifier, lair: `${slug}-lair-keystore`, conductor: `${slug}-holochain`, port: String(port ?? old.port),
};

const changed = [];
function rewrite(path, change) {
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after !== before) {
    changed.push(path);
    if (!dry) writeFileSync(path, after);
  }
}
const setConst = (text, key, value, quoted = true) =>
  text.replace(new RegExp(`(pub const ${key}: (?:&str|u16) = )"?[^";]+"?;`), (_, head) => `${head}${quoted ? `"${value}"` : value};`);

// 1. The one place the Rust code reads its names from.
rewrite("src-tauri/src/names.rs", (t) => {
  for (const [key, value] of [
    ["APP_NAME", next.name], ["APP_IDENTIFIER", next.identifier], ["LOG_FILE_NAME", slug], ["LOG_FOLDER_NAME", next.name],
    ["CONDUCTOR", next.conductor], ["LAIR", next.lair],
    ["RELEASES_URL", `https://github.com/${repo}/releases`], ["CHANNEL_PREFIX", slug],
    ["ORIGIN_PREFIX", slug.slice(0, 2)],
    ["SEED_TAG", `${slug}-device-seed`], ["RECOVERY_FILE", `${slug}-recovery.json`],
  ]) t = setConst(t, key, value);
  // The Starter's release signer is not yours. With none listed the app
  // does not update itself, which is right until you list your own.
  t = t.replace(/(pub const RELEASE_SIGNERS: &\[&str\] = )&\[[^\]]*\];/, (_, head) => `${head}&[${signer ? `"${signer}"` : ""}];`);
  return setConst(t, "ADMIN_PORT", next.port, false);
});

// 2. The page's copy of the name, and the configs that cannot read names.rs.
rewrite("src/lib/app.ts", (t) => t.replace(/(export const APP_NAME = )"[^"]*";/, `$1"${next.name}";`));
rewrite("src-tauri/tauri.conf.json", (t) => {
  const conf = JSON.parse(t);
  conf.productName = next.name;
  conf.identifier = next.identifier;
  for (const w of conf.app?.windows ?? []) if (w.title === old.name) w.title = next.name;
  if (conf.bundle?.externalBin) conf.bundle.externalBin = conf.bundle.externalBin.map((b) => b.replace(`binaries/${oldSlug}-`, `binaries/${slug}-`));
  return JSON.stringify(conf, null, 2) + "\n";
});
rewrite("src-tauri/Cargo.toml", (t) =>
  t.replace(/^name = "[^"]+"/m, `name = "${slug}"`).replace(/^description = "[^"]*"/m, `description = "${next.name}"`).replace(/^authors = \[[^\]]*\]/m, `authors = ["${next.name}"]`));
rewrite("package.json", (t) => t.replace(/^(\s*"name":\s*)"[^"]+"/m, `$1"${slug}"`));

// 3. Scripts, the UI suite and workflows: the sidecar names, the identifier,
//    the window's title and the program's own file name, as whole words.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s) => new RegExp(`(?<![A-Za-z0-9_-])${escape(s)}(?![A-Za-z0-9_-])`, "g");
const inScripts = (t) => {
  t = t.replace(word(old.conductor), next.conductor).replace(word(old.lair), next.lair);
  t = t.replace(word(old.identifier), next.identifier);
  // A sidecar named by a pattern (`starter-(holochain|lair)`), and test data folders.
  t = t.replace(new RegExp(`(?<![A-Za-z0-9_-])${escape(oldSlug)}-(\\(holochain|test-|e2e-)`, "g"), `${slug}-$1`);
  t = t.replace(new RegExp(`(const WINDOW_TITLE = )"${escape(old.name)}"`), `$1"${next.name}"`);
  // `pgrep -x starter`, `target/debug/starter`, the built program in a workflow.
  return t.replace(new RegExp(`(pgrep -x |target/debug/|target/release/|"debug", ")${escape(oldSlug)}(?![A-Za-z0-9_-])`, "g"), `$1${slug}`);
};
const scriptFiles = [];
const walk = (dir, depth = 0) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) { if (depth < 2 && !["node_modules", "target", "dist", "gen", "profile", "shots"].includes(entry)) walk(path, depth + 1); }
    else if (/\.(sh|mjs|ts|yml|yaml|cmd|ps1)$/.test(entry) && entry !== "rename-app.mjs") scriptFiles.push(path);
  }
};
for (const dir of ["scripts", "src-tauri/scripts", ".github/workflows", "e2e", "node"]) walk(dir);
for (const path of scriptFiles) rewrite(path, inScripts);

console.log(`${dry ? "Would change" : "Changed"} ${changed.length} file(s):`);
for (const path of changed) console.log(`  ${path}`);
console.log(`
Still yours to do:
  - Register your app at dev.flowsta.com and put its client id in .env (VITE_FLOWSTA_CLIENT_ID).
  - The sidecar files in src-tauri/binaries/ are named after the slug: fetch them again, or rename them (${next.conductor}-<target>, ${next.lair}-<target>).
  - ${signer ? "RELEASE_SIGNERS in src-tauri/src/names.rs now holds your release identity." : "In src-tauri/src/names.rs, RELEASE_SIGNERS is now empty: the app does not update itself until you list the Flowsta identity YOUR releases are signed with (RELEASING.md)."}
  - In src-tauri/tauri.conf.json, plugins.updater.pubkey: the PUBLIC half of your own updater key (npx tauri signer generate). Until then your app cannot install an update.
  - For a signed Windows installer: the WINDOWS_PUBLISHER repository variable, the name on your certificate (RELEASING.md).
  - Icons (src-tauri/icons/), the README, and your own record in place of the note (README, "Make it yours").
  - Your own bootstrap server and always-on node before you release (README, "Servers").
  - Never change the identifier of an app you have released: its data folder and its board are named after it.`);
