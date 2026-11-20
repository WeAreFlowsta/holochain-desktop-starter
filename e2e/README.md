# The UI suite

WebdriverIO drives the REAL app: the test build with an embedded WebDriver (the `e2e` cargo feature, never in a release). Each run starts from an empty data folder in `e2e/profile` and never touches an installed copy or a person's own Vault.

```bash
npm run e2e:build      # the test build (about ten minutes the first time)
npm run e2e            # the specs in specs/fresh
```

Screenshots land in `e2e/shots`. On Linux the window must be on a display the test can see: your desktop with the screen unlocked, or a virtual one (`xvfb-run -a npm run e2e`).

## Two sets of specs

**`specs/fresh`** need nothing but the app: the first launch, the board and the private tab signed out, a write refused without a sign-in, Settings.

**`specs/vault`** are one person's first hour, in order, each file a new start of the app on the same data folder (the last one on a new, empty one):

| Spec | What it shows |
| --- | --- |
| `01-sign-in` | Signed out at first; the header's sign-in connects to the Vault; the Identity page and the header say who is signed in; the Notes page shows the form. |
| `02-board` | A note written on the board is listed as the person's own, edited and deleted; an empty note cannot be saved. |
| `03-my-notes` | The private tab asks to be set up; the set-up restarts Holochain once; a private note is written; each tab lists its own notes; the Identity page says a backup was saved. |
| `04-restore` | Nothing is offered while a backed-up note is on the device; a note the person deleted stays deleted; a note the device has never seen is written back, once. |
| `05-disconnect` | Disconnect on the Identity page; the header offers the sign-in again; the board and the private notes are read without a form to write. |
| `06-new-device` | The same person on a second, empty data folder against the same Vault: after the sign-in and the set-up, My notes says how many notes the Vault backup holds that are not on this device; one press restores them, and nothing more is offered. |

They need a Flowsta Vault that approves the sign-in by itself, which is the Vault's own test build:

1. Clone [flowsta-vault-app](https://github.com/WeAreFlowsta/flowsta-vault-app) and build its test binary (`scripts/build-test-binary.sh` there).
2. Run with where it is and the API its test identity is made on:

```bash
STARTER_E2E_VAULT_REPO=/path/to/flowsta-vault-app \
STARTER_E2E_VAULT_API=<the Flowsta API your test identities live on> \
node e2e/run.mjs vault
```

The suite starts that Vault with a new identity, points the app at it, and stops it afterwards.

## What every spec checks without being asked

After every test, `specs/_helpers.ts` reads the window and runs it through `src/lib/sense.ts`: two things on the screen that cannot both be true (the header offers to sign in while the page shows the form to write), or a sentence no person would write ("1 notes"). A spec fails at its end if anything stood for about 40 seconds.

When someone sees a screen that does not make sense, add the check to `sense.ts` first, with the screen they saw as its unit test (`sense.test.ts`). Then fix the screen.

Each spec also collects wording the app must never show (a raw error code, `undefined`, an HTTP status) and fails on any.
