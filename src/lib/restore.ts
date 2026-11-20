// Bringing private notes back from the person's Vault backup.
//
// Private notes live on the person's own devices and nowhere else, so a
// device that is lost takes its notes with it unless another device has
// them. The Vault backup is the other copy: the Vault keeps what each
// device backed up, and shares it between the person's devices. This module
// reads those backups and says which notes in them are not on this device;
// the Notes page offers to write them back (`restore_my_notes` in notes.rs).
//
// The page offers and the person decides, on purpose. A second device that
// has just been set up is also missing every note for a minute, until it
// hears from the first one. Restoring then is harmless (a note and its
// restored copy are shown once: the private notes zome pairs them), but it
// is not needed, and the offer says so.
//
// Board notes are not restored: every peer holds the board, so they come
// back from the network by themselves.
//
// For a fork: when you add a record to the private network, add it to the
// backup (`build_backup` in notes.rs), to `notesIn` below and to
// `restore_my_notes`. A record that is backed up and never read back is
// half a feature.
//
// The Vault and the Rust side are imported where they are used, so the
// functions that only compare lists run in a plain unit test
// (restore.test.ts).
import type { Note } from "./holochain";

/** A private note as a backup holds it. */
export interface BackedUpNote {
  id: string;
  text: string;
  restored_from?: string | null;
}

/** The private notes in one backup's data, or none when it holds no such list. */
export function notesIn(backup: unknown): BackedUpNote[] {
  const list = (backup as { my_notes?: unknown } | null | undefined)?.my_notes;
  if (!Array.isArray(list)) return [];
  return list.filter((n): n is BackedUpNote => !!n && typeof n.id === "string" && typeof n.text === "string");
}

/** The id a note had when it was first written, whatever restores it has been through. */
const origin = (n: { id: string; restored_from?: string | null }) => n.restored_from || n.id;

/**
 * The notes in `backups` that are not among the notes `here`, each once.
 * `backups`: the newest first, so a note that several backups hold comes
 * back with its newest text.
 */
export function missingFromBackups(backups: unknown[], here: Note[]): BackedUpNote[] {
  const have = new Set(here.map(origin));
  const missing: BackedUpNote[] = [];
  for (const backup of backups) {
    for (const note of notesIn(backup)) {
      if (have.has(origin(note))) continue;
      have.add(origin(note));
      missing.push(note);
    }
  }
  return missing;
}

/**
 * Ask the Vault for this app's backups, from this device and from the
 * person's other devices, and return the private notes that are not here.
 * Empty when the Vault is closed or locked, or holds no backup: there is
 * then nothing to offer, and nothing to say.
 */
export async function findRestorable(here: Note[]): Promise<BackedUpNote[]> {
  try {
    const { retrieveFromVault, listVaultBackups } = await import("@flowsta/holochain");
    const { CLIENT_ID, vaultLinkOptions } = await import("./signin");
    const pin = await vaultLinkOptions();
    const who = { clientId: CLIENT_ID, ...pin };
    const found: { data: unknown; createdAt: number }[] = [];
    const own = await retrieveFromVault(who).catch(() => null);
    if (own) found.push(own);
    const stats = await listVaultBackups(pin.ipcUrl, { clientId: CLIENT_ID });
    for (const other of stats.otherDevices ?? []) {
      const theirs = await retrieveFromVault({ ...who, label: "latest", across: "devices", device: other.device }).catch(() => null);
      if (theirs) found.push(theirs);
    }
    found.sort((a, b) => b.createdAt - a.createdAt);
    const missing = missingFromBackups(found.map((f) => f.data), here);
    if (missing.length === 0) return [];
    // The device has the last word: a note it has seen before (one the
    // person deleted, for instance) is not offered back.
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<BackedUpNote[]>("restorable_notes", { notes: missing });
  } catch {
    return [];
  }
}

/** Write `notes` back to the private network. Returns how many were written. */
export async function restoreNotes(notes: BackedUpNote[]): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  const written = await invoke<number>("restore_my_notes", { notes });
  // The restored notes are this device's now: its own backup should hold them.
  if (written > 0) (await import("./backup")).requestBackupSoon();
  return written;
}

/** "1 note" or "3 notes". */
export function countOfNotes(n: number): string {
  return `${n} note${n === 1 ? "" : "s"}`;
}
