#!/usr/bin/env node
// The bundled hApp files must agree in four places, or a fresh install
// fails with "the bundled file was not found", or ships a DNA that is not
// the one committed and tested:
//   1. dna/*/workdir/*.happ          what dna/build.sh packed (committed)
//   2. src-tauri/resources/          the copies the installer ships
//   3. src-tauri/tauri.conf.json     bundle.resources: what the installer includes
//   4. src-tauri/src/kits.rs         each file's name and SHA-256
// Run from the repository root. Exit 1 on any difference.
//
//   node scripts/check-bundle-sync.mjs           check
//   node scripts/check-bundle-sync.mjs --write   after dna/build.sh: copy the packed
//                                                files into resources/ and write
//                                                their hashes into kits.rs
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const write = process.argv.includes("--write");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The packed files, by name.
const packed = new Map();
for (const dna of readdirSync("dna", { withFileTypes: true })) {
  const workdir = join("dna", dna.name, "workdir");
  if (!dna.isDirectory() || !existsSync(workdir)) continue;
  for (const f of readdirSync(workdir)) if (f.endsWith(".happ")) packed.set(f, join(workdir, f));
}

let kits = readFileSync("src-tauri/src/kits.rs", "utf8");
if (write) {
  for (const [name, path] of packed) {
    copyFileSync(path, join("src-tauri/resources", name));
    const entry = new RegExp(`(KitFile \\{ name: "${name}", sha256: ")[0-9a-f]{64}(" \\})`);
    if (!entry.test(kits)) {
      console.error(`bundle-sync: kits.rs has no KitFile named ${name}: add it there (and to tauri.conf.json's bundle.resources), then run this again`);
      process.exit(1);
    }
    kits = kits.replace(entry, `$1${sha(path)}$2`);
  }
  writeFileSync("src-tauri/src/kits.rs", kits);
}

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const bundled = (conf.bundle?.resources || []).filter((r) => r.endsWith(".happ")).map((r) => r.replace(/^resources\//, "")).sort();
const kitFiles = [...kits.matchAll(/KitFile \{ name: "([^"]+)", sha256: "([0-9a-f]{64})" \}/g)].map((m) => ({ name: m[1], sha256: m[2] }));

const problems = [];
if (bundled.length === 0) problems.push("tauri.conf.json bundles no .happ file");
for (const name of bundled) {
  const shipped = `src-tauri/resources/${name}`;
  if (!existsSync(shipped)) {
    problems.push(`${name}: bundled, but not in src-tauri/resources`);
    continue;
  }
  const source = packed.get(name);
  if (!source) problems.push(`${name}: bundled, but no dna/*/workdir holds it (run dna/build.sh)`);
  else if (sha(source) !== sha(shipped)) problems.push(`${name}: the app's copy is not ${source} (run this with --write)`);
  const kit = kitFiles.find((k) => k.name === name);
  if (!kit) problems.push(`${name}: bundled, but kits.rs does not name it`);
  else if (kit.sha256 !== sha(shipped)) problems.push(`${name}: kits.rs says ${kit.sha256}, the file is ${sha(shipped)} (run this with --write)`);
}
for (const k of kitFiles) if (!bundled.includes(k.name)) problems.push(`${k.name}: in kits.rs, but not bundled (tauri.conf.json)`);
for (const name of packed.keys()) if (!bundled.includes(name)) problems.push(`${name}: packed in dna/, but not bundled (tauri.conf.json)`);

if (problems.length) {
  console.error("bundle-sync: the bundled hApp files do not agree:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`bundle-sync OK: ${bundled.join(", ")}`);
