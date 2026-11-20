// What the page keeps in step with the open profile for the Flowsta SDK
// (`bindOpenProfile`), and how one page asks another to start the sign-in.
//
// For a fork: call `vaultLinkOptions()` before any call you make to the
// Vault through the SDK, as lib/backup.ts does. It makes sure the SDK
// speaks for the profile that is open.
//
// What a page wants from the sign-in (start it at once, come back here
// afterwards) is passed in sessionStorage, not in the address: the static
// build drops query parameters inside the app's window.
//
// A page sets the intent, then nav("/identity/"); the identity page reads
// and clears it.

const AUTO_LINK_KEY = "starter.signin.autoLink";
const RETURN_TO_KEY = "starter.signin.returnTo";

export interface SignInIntent {
  autoLink: boolean;
  returnTo: string | null;
}

export function setSignInIntent(intent: { autoLink?: boolean; returnTo?: string | null }): void {
  if (intent.autoLink) {
    sessionStorage.setItem(AUTO_LINK_KEY, "true");
  } else {
    sessionStorage.removeItem(AUTO_LINK_KEY);
  }
  if (intent.returnTo) {
    sessionStorage.setItem(RETURN_TO_KEY, intent.returnTo);
  } else {
    sessionStorage.removeItem(RETURN_TO_KEY);
  }
}

export function readAndClearSignInIntent(): SignInIntent {
  const autoLink = sessionStorage.getItem(AUTO_LINK_KEY) === "true";
  const returnTo = sessionStorage.getItem(RETURN_TO_KEY);
  sessionStorage.removeItem(AUTO_LINK_KEY);
  sessionStorage.removeItem(RETURN_TO_KEY);
  return {
    autoLink,
    returnTo: returnTo && returnTo.startsWith("/") ? returnTo : null,
  };
}

/** The app's Flowsta client id, from `.env` (the Rust side is built with the same one). */
export const CLIENT_ID: string = import.meta.env.VITE_FLOWSTA_CLIENT_ID;

// Sign-ins and disconnects under way. Each sets the SDK's binding and link
// token itself, a step ahead of the profile's files, so `bindOpenProfile`
// stands back until it is done.
let linkChanges = 0;

/**
 * Run a sign-in or a disconnect. When it ends, however it ends, the SDK is
 * set from the open profile again.
 */
export async function whileLinkChanges<T>(change: () => Promise<T>): Promise<T> {
  linkChanges++;
  try {
    return await change();
  } finally {
    linkChanges--;
    await bindOpenProfile();
  }
}

// The key this install links with: this device's key. It does not change
// while the page is open.
let installKey: string | null = null;

/**
 * Tell the Flowsta SDK which profile is open: the identity it is signed in
 * as, and its link token.
 *
 * The SDK keeps one "bound identity" per app in the page's storage, set
 * when a link is made, and refuses every Vault call (backups among them)
 * while the Vault holds another identity. The app keeps a profile per
 * identity and opens the one the Vault has unlocked, so that one value
 * must follow the profile: without this, the profile that was not the
 * last to sign in had every backup refused as "a different identity".
 * A profile with no link clears the value, so its sign-in starts clean.
 *
 * The link token is what the Vault gave when the profile was linked, and
 * what tells this app from any other app that connects the same way.
 * The profile's copy on the Rust side is the one that counts (it is what
 * the Rust side presents too); the SDK is given the same one, or none for
 * a profile that has none, so both sides always present the same thing.
 */
export async function bindOpenProfile(): Promise<void> {
  if (linkChanges > 0) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const sdk = await import("@flowsta/holochain");
    const link = await invoke<{ vault_agent_pub_key: string } | null>("get_identity_link");
    const linked = link?.vault_agent_pub_key ?? null;
    if (linkChanges === 0 && linked !== sdk.getBoundIdentity()) {
      if (linked) {
        sdk.bindVaultIdentity(linked);
      } else {
        sdk.clearBoundIdentity();
      }
      console.log(`the Vault binding follows the open profile (${linked ? "signed in" : "not signed in"})`);
    }

    if (!installKey) {
      const status = await invoke<{ agent_pub_key: string | null }>("get_app_status");
      installKey = status.agent_pub_key;
      // Still starting: the next call sets the token.
      if (!installKey) return;
      sdk.selectVaultLink(CLIENT_ID, installKey);
    }
    const token = await invoke<string | null>("get_vault_link_token");
    if (linkChanges > 0) return;
    const held = sdk.getVaultLinkToken(CLIENT_ID, installKey);
    if (token && token !== held) {
      sdk.setVaultLinkToken(CLIENT_ID, installKey, token);
    } else if (!token && held) {
      sdk.clearVaultLinkToken(CLIENT_ID, installKey);
    }
  } catch (e) {
    // Not in the app (a browser preview), or the app is still starting:
    // the next call binds.
    console.warn("could not set the Vault binding from the profile", e);
  }
}

/** What every call to the Vault through the SDK takes first: the binding
 * and the link token follow the open profile (`bindOpenProfile`), and a
 * test build pins the Vault it talks to. A release build pins none, and the
 * SDK finds the Vault itself. */
export async function vaultLinkOptions(): Promise<{ ipcUrl?: string }> {
  await bindOpenProfile();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const url = await invoke<string | null>("test_vault_url");
    return url ? { ipcUrl: url } : {};
  } catch {
    return {};
  }
}
