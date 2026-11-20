// Bringing the app's window back to the front after the Vault was in front
// of it (a sign-in). For a fork: nothing to change here.
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

/**
 * Bring the app's own window back to the foreground after a cross-app flow
 * (e.g. Flowsta sign-in, where the Vault popped up to ask for approval), so the
 * user lands back here and sees the result.
 *
 * The Vault gives the focus back after the person answers, so this matters
 * most when the Vault was already open and stayed in front:
 * `requestUserAttention` then flashes this app's taskbar entry. It does
 * nothing when the window already has the focus, and never throws.
 */
export async function focusSelf(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
    await w.requestUserAttention(UserAttentionType.Informational);
  } catch {
    // Coming to the front is a nicety, never a requirement.
  }
}
