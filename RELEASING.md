# Releasing

A release is two steps: a tag that builds the installers, and a signature that tells installed copies they may take the update.

## Before your first release

**1. Your own names.** Run `scripts/rename-app.mjs` (README, "Make it yours") and register your app at [dev.flowsta.com](https://dev.flowsta.com). Never release under the Starter's identifier or on the Starter's board.

**2. Your own servers.** A bootstrap and relay server, and an always-on node for the board (README, "Servers"). The public test servers the app defaults to are not for released software.

**3. Your release identity.** An installed copy takes an update only when its manifest is signed by a Flowsta identity compiled into that copy. Create the identity you will sign releases with in your Flowsta Vault (an identity for your project, not your personal one, so the role can be handed over), and put its DID in `RELEASE_SIGNERS` in `src-tauri/src/names.rs`, replacing the Starter's. You can list more than one. The rename script empties the list (or sets it, with `--signer`): until an identity is listed, the app does not update itself and says so on Settings > Updates.

Changing the signers later reaches people only through an update signed by a signer they already have, so list a second identity kept somewhere safe before you need it.

**4. Let the release tool connect.** `scripts/release-manifest.mjs` talks to your Vault as your app, from the origin `http://localhost:7331`. Add that origin to your app's registered origins at dev.flowsta.com. It publishes to your repository through the GitHub CLI: sign in once with `gh auth login`, or set a `GITHUB_TOKEN` that may write releases.

**The repository's releases must be public.** Installed copies download each update, and the signed manifest that allows it, from your repository's release pages without signing in to GitHub. The release tool reads the files the same way, so in a private repository it stops at the first one (`404`). Build and try the app from a private repository as long as you like; the first release people can update from needs the repository public.

**5. The secrets the workflow reads** (repository settings, Secrets and variables, Actions). All but the updater's key are optional; the table says what you get without each.

| Secret | What it is | Without it |
|---|---|---|
| `VITE_FLOWSTA_CLIENT_ID` | your app's client id from dev.flowsta.com | sign-in does not work |
| `STARTER_BOOTSTRAP_URL` | your bootstrap server (it is the relay too) | the public Holochain test servers |
| `STARTER_RELAY_URL` | your relay, only when it is on another host than your bootstrap server | the bootstrap server's own host |
| `STARTER_AUTH_MATERIAL` | standard base64, with `=` padding, of the bytes your bootstrap's authentication hook expects | no auth is sent |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the updater's key (`npx tauri signer generate`); put its PUBLIC key in `src-tauri/tauri.conf.json`, `plugins.updater.pubkey`, replacing the Starter's | **required**: the workflow stops, because a release nobody can update from is not worth publishing |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` | macOS signing and notarization | an unsigned `.dmg` that Gatekeeper warns about |
| `ESIGNER_USERNAME`, `ESIGNER_PASSWORD`, `ESIGNER_CREDENTIAL_ID`, `ESIGNER_TOTP_SECRET` | Windows code signing with SSL.com eSigner (billed per signing; `-beta` tags skip it) | an unsigned installer that SmartScreen warns about |

One repository **variable** (not a secret) goes with Windows signing: `WINDOWS_PUBLISHER`, the name on your certificate as Windows shows it. The release page names it, so people can compare it with what Windows shows them.

### Signing for macOS and Windows

Both are optional and both cost money. Without them the build still works: macOS warns at the first open (right-click, Open) and Windows SmartScreen warns at the install. Add them when people outside your team start installing.

**macOS: your Apple Developer account.** You need a paid Apple Developer Program membership. From it:

| Secret | Where it comes from |
|---|---|
| `APPLE_CERTIFICATE` | A **Developer ID Application** certificate, exported from Keychain Access with its private key as a `.p12` file, then base64 (`base64 -i certificate.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you gave the `.p12` when you exported it |
| `APPLE_SIGNING_IDENTITY` | The certificate's full name: `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_KEY` | The **key ID** of an App Store Connect API key (Users and Access, Integrations), used for notarization |
| `APPLE_API_ISSUER` | The issuer ID shown on that same page |
| `APPLE_API_KEY_PATH` | Despite its name, the **contents** of the key's `.p8` file, base64 (`base64 -i AuthKey_XXXX.p8`). Apple lets you download that file once |

Set all six or none. The workflow signs and notarizes when they are set, and builds an ad-hoc signed app when they are not.

**Windows: the signing service you choose.** Windows certificates are sold by several authorities, and each has its own signing tool. The Starter is wired for one, SSL.com's eSigner, through the four `ESIGNER_*` secrets. To use another (Azure Trusted Signing, DigiCert KeyLocker, a certificate on a hardware token with `signtool`), change these places:

1. `src-tauri/scripts/sign-windows.ps1`. Tauri calls it once for each file to sign (`bundle.windows.signCommand` in `src-tauri/tauri.conf.json`). Replace the CodeSignTool call with your service's command, and the `ESIGNER_USERNAME` check that decides whether to sign at all with a check on your own secret.
2. `.github/workflows/build-release.yml`. In the `build` job, replace the `ESIGNER_*` lines under `env:` with your secrets, and the two steps "Setup Java (Windows)" and "Download CodeSignTool (Windows)" with whatever installs your tool. In the `create-release` job, `WINDOWS_SIGNED` reads `ESIGNER_USERNAME` to decide what the release page says: point it at your secret.

Signing services bill for each signature, and a build signs several files. A tag with `-beta` in it skips Windows signing for that reason; `-rc` and plain versions sign.

Two keys, two jobs: the updater's key proves a file came from your build; your release identity's signature proves you meant to publish it. An app from the Starter checks both.

## Each release

**1. The version**, the same in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`. Write a pre-release as a word, a dot and a number: `1.2.0-beta.1`, `1.2.0-rc.1`. The updater compares versions by semver, where `beta10` sorts below `beta9` and would never be offered; a unit test fails the build on a version written that way.

**2. The changelog.** Add a `## [1.2.0] - 2026-01-31` block to `CHANGELOG.md`. It becomes the release page's text; a tag with no block stops the workflow.

**3. The checks.**

```bash
node scripts/check-bundle-sync.mjs            # the packed DNAs, the app's copies and their hashes agree
cd src-tauri && cargo test --lib && cargo check --release
```

and the DNA tests and the UI suite (README, "Tests") on the commit you tag. If a DNA changed, read "When your DNA changes" in the README first.

**4. Tag and push.**

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/build-release.yml` builds for Linux, macOS (both) and Windows, fetches the conductor and key store and checks them against `.github/holochain-sidecars.sha256`, and publishes the release with `SHA256SUMS.txt`. A version with a hyphen is published as a pre-release.

**5. Sign the manifest.** Open your Vault, unlocked as your release identity. From the repository root:

```bash
node scripts/release-manifest.mjs v1.2.0 --dry-run     # read it first: version, channel, sequence, every file's hash
node scripts/release-manifest.mjs v1.2.0
```

Your Vault shows the app, the version, the channel and every file. Scroll to the end of the list, compare it with the tool's lines, and approve. The tool checks the signature against `RELEASE_SIGNERS` and publishes the channel's two files. It must end with `<channel> channel (...) now points at 1.2.0`.

Until this step is done, the release is on its page and no installed copy takes it.

**6. See it arrive.** On an installed copy, the log reads `[update] downloading ...`, `ready: installs at "Restart to update"`, then after the restart `checked: up to date`. An installed copy checks 90 seconds after it starts and every four hours.

## Channels

A copy installed from a pre-release follows the beta channel and takes the stable release when it comes; a copy installed from a stable release sees stable releases only. Each channel is a fixed pre-release in your repository (`<prefix>-beta`, `<prefix>-stable`) holding two files. A third, `<prefix>-updates`, holds the files only the updater downloads (the macOS update archives and their signatures), so the release page shows people the installers and nothing else. The tool creates all three at their first use.

## What can go wrong

- **"the signature is not by an identity in RELEASE_SIGNERS".** Your Vault is unlocked as another identity than the one compiled into the app. Nothing was published.
- **"... does not sort above ...".** The version would not be seen as newer by installed copies. Fix the version and tag again.
- **A copy says it is up to date and the release is out.** The manifest is not signed yet (step 5), or the copy checked less than four hours ago: restart it.
- **You tagged the wrong commit.** Delete the release and the tag, and tag again, before step 5. After step 5, release a higher version instead: copies may already have it.
