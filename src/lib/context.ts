// What every page can read about the person's sign-in, provided once by the
// layout (routes/layout.tsx).
//
// For a fork: read these in your pages. `linkedContext` answers "may this
// person write?"; `linkStateContext` is the full state when a page has
// something to say about it.
import { createContextId, type Signal } from "@builder.io/qwik";

/**
 * The four states a profile can be in with the Flowsta Vault. A plain
 * "signed in or not" leaves people stuck when the Vault is closed or when
 * another identity is unlocked in it.
 *
 * - `linked`:   signed in, and the Vault is running, unlocked as the same
 *               identity, and knows this app's key.
 * - `offline`:  signed in, and the Vault is closed, locked or not
 *               answering. That is the Vault's normal resting state, so
 *               the person reads and writes as usual. What waits for the
 *               Vault is only what needs it: the backup, setting up the
 *               private notes, refreshing the name and picture.
 * - `mismatch`: signed in, but the Vault is unlocked as ANOTHER identity
 *               (or does not know this app's key). Nothing is written
 *               while someone else's Vault is open; a banner asks the
 *               person to unlock theirs or to disconnect. The link is
 *               never revoked for them.
 * - `unlinked`: not signed in. Reading works; the page offers the sign-in.
 *
 * The Rust side makes the same decision before every write
 * (`require_identity_link`), whatever the page shows.
 */
export type LinkState = "linked" | "offline" | "mismatch" | "unlinked";

export const linkStateContext = createContextId<Signal<LinkState>>("app.linkState");

/**
 * May this person write? True in `linked` and in `offline`. A page that has
 * something to say about the difference reads `linkStateContext`.
 */
export const linkedContext = createContextId<Signal<boolean>>("app.linked");

export const displayNameContext = createContextId<Signal<string | null>>("app.displayName");
export const profilePictureContext = createContextId<Signal<string | null>>("app.profilePicture");
