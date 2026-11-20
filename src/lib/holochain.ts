// The page's calls to the Rust side.
//
// The page never talks to Holochain itself: every call is a Tauri command
// (`src-tauri/src/notes.rs` and `commands.rs`). This file is the one place
// they are named and typed on this side.
//
// Every wrapper that WRITES asks for a Vault backup soon afterwards
// (`requestBackupSoon`), so a note written two minutes before the laptop
// closes is in the person's Vault. Keep new writes on that pattern.
import { invoke } from "@tauri-apps/api/core";
import { requestBackupSoon } from "./backup";

// ── Notes (notes.rs): yours to change ─────────────────────────────────

/** Which network a call means: the shared board, or the person's own. */
export type Place = "board" | "my_notes";

export interface Note {
  /** The note's first record: what an edit and a delete name. */
  id: string;
  /** The key that wrote it (a device's key). */
  author: string;
  text: string;
  /** Microseconds since 1970. */
  created_at: number;
  edited_at: number | null;
  /** For a private note restored from a Vault backup: the id it had there. */
  restored_from?: string | null;
}

/** What `get_notes` answers for "my_notes" before the person's own network
 * is set up on this device: the page shows the set-up step, not an error. */
export const MY_NOTES_NOT_SET_UP = "MY_NOTES_NOT_SET_UP";

export async function getNotes(place: Place): Promise<Note[]> {
  return invoke<Note[]>("get_notes", { place });
}

export async function createNote(place: Place, text: string): Promise<string> {
  const id = await invoke<string>("create_note", { place, text });
  requestBackupSoon();
  return id;
}

export async function editNote(place: Place, id: string, text: string): Promise<void> {
  await invoke("edit_note", { place, id, text });
  requestBackupSoon();
}

export async function deleteNote(place: Place, id: string): Promise<void> {
  await invoke("delete_note", { place, id });
  requestBackupSoon();
}

/** Set the person's own network up on this device (needs their Vault
 * unlocked, once). Holochain restarts once afterwards. */
export async function setUpMyNotes(): Promise<void> {
  await invoke("set_up_my_notes");
}

// ── Flowsta sign-in (commands.rs): kept as it is by most forks ─────────

export interface CachedProfile {
  display_name: string | null;
  profile_picture: string | null;
}

export async function getCachedProfile(): Promise<CachedProfile | null> {
  return invoke<CachedProfile | null>("get_cached_profile");
}

export async function saveProfileCache(displayName: string | null, profilePicture: string | null): Promise<void> {
  await invoke("save_profile_cache", { displayName, profilePicture });
}

export interface IdentityLinkData {
  /** The Flowsta identity this profile is signed in as. */
  vault_agent_pub_key: string;
  /** The link record on the network. */
  entry_action_hash: string;
  linked_at: number;
}

export async function getIdentityLink(): Promise<IdentityLinkData | null> {
  return invoke<IdentityLinkData | null>("get_identity_link");
}

/** The last step of sign-in: write the link the Vault signed. */
export async function commitIdentityLink(vaultAgentPubKey: string, vaultSignature: string): Promise<string> {
  return invoke<string>("commit_identity_link", { vaultAgentPubKey, vaultSignature });
}

/** Sign this profile out: here at once, then on the network. */
export async function revokeIdentityLink(): Promise<void> {
  await invoke("revoke_identity_link");
}

/** Whether the network links this device's key to the identity signed in here. */
export async function identityLinkedOnNetwork(agentPubKey: string): Promise<boolean> {
  return invoke<boolean>("identity_linked_on_network", { agentPubKey });
}

/**
 * Every key that is this person on the board: this device's, and those of
 * their other devices signed in as the same identity. For "is this note
 * mine?" only. The other devices' links arrive over the network, so ask
 * again on an interval.
 */
export async function getMyAgentSet(): Promise<string[]> {
  return invoke<string[]>("get_my_agent_set");
}
