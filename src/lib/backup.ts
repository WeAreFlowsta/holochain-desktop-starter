// Vault backups of the person's own notes.
//
// The layout starts the SDK's hourly backup (`startAutoBackup`) while a
// person is signed in. On its own that would leave a note written two
// minutes after launch out of the Vault until the next hour, so every
// successful write also schedules one here: 30 seconds after the last
// write, at most one at a time.
//
// Forks: call `requestBackupSoon()` after every successful write. The
// wrappers in `holochain.ts` already do.
import { invoke } from "@tauri-apps/api/core";
import { APP_NAME } from "./app";
import { vaultRefusalMessage } from "./errors";
import { CLIENT_ID, vaultLinkOptions } from "./signin";

const DEBOUNCE_MS = 30_000;

/** The person's own notes, gathered on the Rust side (notes.rs). */
export async function buildBackup(): Promise<unknown> {
  const myAgents = await invoke<string[]>("get_my_agent_set");
  return invoke("build_backup", { myAgents });
}

/**
 * Tell the Rust side what a backup attempt did. It writes the log and keeps
 * the last outcome for the Identity page, so a stale backup date has an
 * explanation outside the console. Fire and forget.
 */
export function reportBackupOutcome(saved: boolean, detail: string): void {
  void invoke("report_backup_outcome", { status: saved ? "saved" : "skipped", detail }).catch(() => {});
}

/** What the last attempt did, as the Rust side remembers it. */
export interface BackupOutcome {
  status: "saved" | "skipped";
  detail: string | null;
  /** Unix seconds. */
  at: number;
}

export async function getLastBackupOutcome(): Promise<BackupOutcome | null> {
  try {
    return await invoke<BackupOutcome | null>("get_last_backup_outcome");
  } catch {
    return null;
  }
}

let enabled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let queued = false;

/**
 * On while a person is signed in here: the layout flips this with the same
 * signal that starts and stops the hourly backup.
 */
export function setBackupTriggersEnabled(on: boolean) {
  enabled = on;
  if (!on && timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Schedule a backup soon. Debounced; safe to call on every write. */
export function requestBackupSoon() {
  if (!enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runBackup(), DEBOUNCE_MS);
}

async function runBackup() {
  timer = null;
  if (inFlight) {
    // A backup is mid-flight; run once more after it finishes so the write
    // that arrived meanwhile isn't lost until the hourly tick.
    queued = true;
    return;
  }
  inFlight = true;
  try {
    const payload = await buildBackup();
    const { backupToVault, wouldOverwriteNonEmptyBackup } = await import("@flowsta/holochain");
    const pin = await vaultLinkOptions();
    // The guard `startAutoBackup` applies itself: an empty backup is never
    // written over one that holds records (a new device that has received
    // nothing yet must not erase the last good backup).
    if (await wouldOverwriteNonEmptyBackup({ clientId: CLIENT_ID, ...pin }, payload)) {
      reportBackupOutcome(false, "Nothing of yours to back up yet. Your Vault keeps the backup it has.");
      return;
    }
    const result = await backupToVault({ clientId: CLIENT_ID, appName: APP_NAME, ...pin }, payload);
    reportBackupOutcome(true, `${result.dataSize} bytes`);
  } catch (e: any) {
    // A skip, not a failure: the hourly backup and the next write both try
    // again. A refusal about this app's connection is said in plain words.
    reportBackupOutcome(false, vaultRefusalMessage(e) ?? e?.message ?? String(e));
  } finally {
    inFlight = false;
    if (queued) {
      queued = false;
      requestBackupSoon();
    }
  }
}
