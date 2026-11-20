// Settings > Identity: sign in with Flowsta, see who is signed in, see what
// the last Vault backup did, and disconnect.
//
// For a fork: keep this page. The sign-in and the disconnect each go
// through one function (lib/vault-link.ts), which is where the link's token
// is kept and cleared; change the wording here, not the order of the steps.
import { component$, useContext, useSignal, useVisibleTask$, $ } from "@builder.io/qwik";
import { useNavigate } from "@builder.io/qwik-city";
import { invoke } from "@tauri-apps/api/core";
import { linkedContext, linkStateContext, displayNameContext, profilePictureContext } from "~/lib/context";
import { sanitizeImageSrc } from "~/lib/sanitize";
import { CLIENT_ID, readAndClearSignInIntent, vaultLinkOptions } from "~/lib/signin";
import { disconnectFromVault, disconnectNotice, signInWithVault } from "~/lib/vault-link";
import { vaultRefusalMessage } from "~/lib/errors";
import { focusSelf } from "~/lib/window";
import { SettingsTabs } from "~/components/settings-tabs/settings-tabs";
import { getLastBackupOutcome, type BackupOutcome } from "~/lib/backup";
import { getIdentityLink, revokeIdentityLink, saveProfileCache } from "~/lib/holochain";

/** What `probe_vault` (Rust) found: this account's Vault, unlocked first. */
interface VaultProbeLite {
  url: string;
  unlocked: boolean;
  agent_pub_key: string | null;
  display_name: string | null;
  profile_picture: string | null;
}

/** Open a web page in the person's browser, never inside this window. */
async function openExternal(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    // The browser could not be opened; the address is shown in the text.
  }
}

/** "at 12:31" today, otherwise the date and time, in the person's locale. */
function formatWhen(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : `on ${d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

export default component$(() => {
  const nav = useNavigate();
  const linkedCtx = useContext(linkedContext);
  const linkStateCtx = useContext(linkStateContext);
  const displayName = useContext(displayNameContext);
  const profilePicture = useContext(profilePictureContext);
  const safeReturnTo = useSignal<string | null>(null);
  const agentKey = useSignal<string | null>(null);
  const linkedVaultKey = useSignal<string | null>(null);
  const loading = useSignal(true);
  const linking = useSignal(false);
  const unlinking = useSignal(false);
  const error = useSignal<string | null>(null);
  const success = useSignal<string | null>(null);
  const autoLink = useSignal(false);
  const showDetails = useSignal(false);
  const confirmUnlink = useSignal(false);
  // This profile's own link file. The network can still show a link for
  // this device's key after the file is gone; the file, not the network,
  // decides whether THIS profile is signed in.
  const hasLocalLink = useSignal(false);
  const backupOutcome = useSignal<BackupOutcome | null>(null);

  // The name and picture from the Vault, for the header and this page, and
  // kept in the profile so they show with the Vault closed.
  const fetchVaultProfile = $(async () => {
    try {
      // The Rust probe asks every Vault port, keeps only this OS account's
      // Vault, prefers the unlocked one, and presents this app's Origin - so
      // the name and picture come back (the Vault scopes them per origin).
      // A fetch to one fixed port reads a different Vault whenever two are
      // running.
      const vault = await invoke<VaultProbeLite | null>("probe_vault");
      if (vault) {
        if (vault.display_name) displayName.value = vault.display_name;
        if (vault.profile_picture) profilePicture.value = vault.profile_picture;
        if (vault.display_name || vault.profile_picture) {
          await saveProfileCache(
            vault.display_name ?? null,
            vault.profile_picture ?? null,
          );
        }
      }
    } catch {
      // The Vault is not running: the layout loads the cached profile.
    }
  });

  // Ask the Vault whether it still knows this link:
  //   - 'linked':   the Vault is running and confirms it.
  //   - 'offline':  the Vault is not reachable; the link file stands.
  //   - 'mismatch': the Vault is running and does not know this app's key.
  //
  // A `mismatch` never revokes the link here. The layout's banner gives
  // the person the choice to unlock their own Vault or to disconnect.
  const fetchVaultLinkState = $(
    async (pubKey: string): Promise<"linked" | "offline" | "mismatch"> => {
      try {
        const { getFlowstaLinkStatus } = await import("@flowsta/holochain");
        const result = await getFlowstaLinkStatus({
          clientId: CLIENT_ID,
          localAgentPubKey: pubKey,
          ...(await vaultLinkOptions()),
        });
        if (result.state === "linked") return "linked";
        if (result.state === "offline") return "offline";
        return "mismatch";
      } catch {
        return "offline";
      }
    },
  );

  // Sign in with Flowsta: the person approves the link in their Vault, it
  // is written to the network, and the profile keeps the link's token
  // (`signInWithVault`). The button and the auto-link both come here.
  const linkIdentity = $(async () => {
    if (!agentKey.value) return;
    error.value = null;
    success.value = null;
    linking.value = true;

    try {
      const vaultKey = await signInWithVault(agentKey.value);
      if (!vaultKey) {
        error.value = "The sign-in was not completed in your Vault.";
        return;
      }

      linkedVaultKey.value = vaultKey;
      hasLocalLink.value = true;
      linkStateCtx.value = "linked";
      linkedCtx.value = true;
      await fetchVaultProfile();
      success.value = "Signed in.";
      await focusSelf();
      const target = safeReturnTo.value;
      if (target) {
        setTimeout(() => nav(target), 1000);
      }
    } catch (e: any) {
      const msg = e.message || String(e);
      const refused = vaultRefusalMessage(e);
      if (refused) {
        error.value = refused;
      } else if (msg.includes("VaultNotFound") || msg.includes("ECONNREFUSED")) {
        // The Vault is not running: try to open it for the person.
        void invoke("launch_vault").catch(() => {});
        error.value =
          "Flowsta Vault is not running, so it is opening now. Once it is ready, click Sign in with Flowsta again.";
      } else if (msg.includes("VaultLocked")) {
        error.value = "Flowsta Vault is locked. Please unlock it first.";
      } else if (msg.includes("UserDenied") || msg.includes("denied")) {
        error.value = "You declined the link request in Flowsta Vault.";
      } else {
        error.value = msg;
      }
    } finally {
      linking.value = false;
    }
  });

  useVisibleTask$(async ({ cleanup }) => {
    // Pull autoLink + returnTo from sessionStorage (set by the caller
    // before nav). See ~/lib/signin.ts.
    const intent = readAndClearSignInIntent();
    autoLink.value = intent.autoLink;
    safeReturnTo.value = intent.returnTo;
    try {
      const status = await invoke<{ agent_pub_key: string | null }>("get_app_status");
      // This device's key: the link is made for it.
      agentKey.value = status.agent_pub_key;

      // Signed in here? The profile's own link file says so, and names the
      // identity. Nothing is ever signed out from this page by itself: the
      // layout's banner gives the person the choice when the Vault holds
      // another identity.
      const link = await getIdentityLink().catch(() => null);
      hasLocalLink.value = link !== null;
      if (link && status.agent_pub_key) {
        linkedVaultKey.value = link.vault_agent_pub_key;
        const vaultState = await fetchVaultLinkState(status.agent_pub_key);
        if (vaultState !== "mismatch" && !displayName.value) {
          await fetchVaultProfile();
        }
      }
    } catch (e) {
      console.error("Failed to get agent key:", e);
    } finally {
      loading.value = false;
    }

    // Asked to sign in on the way here (lib/signin.ts): start it.
    if (autoLink.value && !hasLocalLink.value && agentKey.value) {
      autoLink.value = false;
      await linkIdentity();
    } else if (autoLink.value && hasLocalLink.value) {
      // Already signed in. Changing identity is deliberately two steps:
      // disconnect first (the Rust side refuses a silent rebind too).
      autoLink.value = false;
      error.value =
        "This profile is already signed in with a Flowsta identity. To sign in " +
        "with a different one, disconnect below first.";
    }

    // The last backup outcome is kept by the Rust side; re-read it every
    // 15 s so a backup that lands while this page is open shows up.
    backupOutcome.value = await getLastBackupOutcome();
    const outcomeTimer = setInterval(() => {
      void getLastBackupOutcome().then((o) => (backupOutcome.value = o));
    }, 15_000);
    // The layout watches the sign-in state and updates `linkStateContext`;
    // this page reacts to it and does no polling of its own.
    cleanup(() => clearInterval(outcomeTimer));
  });

  // Disconnect, in this order: the link is revoked on the network and
  // deleted here (that is what ends the sign-in; if it fails, nothing else
  // happens), then the Vault is told and its answer waited for, and the
  // notice says what the Vault did.
  const unlinkIdentity = $(async () => {
    error.value = null;
    success.value = null;
    unlinking.value = true;

    try {
      const vaultKey = linkedVaultKey.value;
      await revokeIdentityLink();
      const outcome = await disconnectFromVault(agentKey.value, vaultKey);
      linkedVaultKey.value = null;
      hasLocalLink.value = false;
      linkStateCtx.value = "unlinked";
      linkedCtx.value = false;
      displayName.value = null;
      profilePicture.value = null;
      confirmUnlink.value = false;
      success.value = disconnectNotice(outcome);
    } catch (e: any) {
      error.value = e.message || String(e);
    } finally {
      unlinking.value = false;
    }
  });

  return (
    <div class="max-w-xl mx-auto">
      <SettingsTabs />

      {loading.value ? (
        <div class="flex flex-col items-center justify-center py-16 gap-4" data-testid="identity-loading">
          <div class="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p class="text-gray-400">Getting your identity ready...</p>
          <p class="text-gray-500 text-sm max-w-xs text-center">
            The first time, this can take up to half a minute.
          </p>
        </div>
      ) : linkedVaultKey.value && hasLocalLink.value ? (
        /* ── Linked state ── */
        <div class="space-y-6" data-testid="identity-linked">
          {/* Profile card */}
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <div class="flex items-center gap-4 mb-4">
              {sanitizeImageSrc(profilePicture.value) ? (
                <img
                  src={sanitizeImageSrc(profilePicture.value)!}
                  alt="Profile"
                  class="h-14 w-14 rounded-full object-cover border border-gray-600"
                  width={56}
                  height={56}
                />
              ) : (
                <div class="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-xl font-medium text-white">
                  {displayName.value ? displayName.value.charAt(0).toUpperCase() : "?"}
                </div>
              )}
              <div>
                <p class="text-white font-medium text-lg" data-testid="identity-display-name">
                  {displayName.value || "Flowsta Account"}
                </p>
                <div class="flex items-center gap-1.5 mt-0.5">
                  <span class="h-2 w-2 rounded-full bg-green-500" />
                  <span class="text-sm text-green-400">Signed in with Flowsta</span>
                </div>
              </div>
            </div>

            <p class="text-sm text-gray-400">
              This device is linked to your Flowsta identity. Notes you write on the board show as yours on every device you sign in on, and your private notes follow you there.
            </p>
          </div>

          {/* Status messages */}
          {error.value && (
            <div class="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded-lg text-sm" data-testid="identity-error">
              {error.value}
            </div>
          )}

          {success.value && (
            <div class="bg-green-900/20 border border-green-800 text-green-300 px-4 py-2 rounded-lg text-sm" data-testid="identity-success">
              {success.value}
            </div>
          )}

          {/* Backups: what the last attempt did. */}
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-6" data-testid="identity-backups">
            <h2 class="text-sm font-semibold text-white mb-1">Backups</h2>
            <p class="text-xs text-gray-500 mb-3">
              Your notes back up to your Flowsta Vault automatically. The Vault keeps them encrypted on your own devices.
            </p>
            {backupOutcome.value ? (
              <p class={["text-xs", backupOutcome.value.status === "saved" ? "text-emerald-400" : "text-amber-300"].join(" ")} data-testid="identity-backup-outcome">
                {backupOutcome.value.status === "saved"
                  ? `Last backup saved ${formatWhen(backupOutcome.value.at)}.`
                  : `Last backup attempt ${formatWhen(backupOutcome.value.at)}: ${backupOutcome.value.detail ?? "not saved"}`}
              </p>
            ) : (
              <p class="text-xs text-gray-500" data-testid="identity-backup-outcome">
                No backup has run since the app was opened. One runs within a minute of your next note, and every hour.
              </p>
            )}
          </div>

          {/* Actions */}
          <div class="space-y-3">
            {!confirmUnlink.value ? (
              <button
                type="button"
                data-testid="identity-disconnect"
                onClick$={() => (confirmUnlink.value = true)}
                class="text-sm text-gray-500 hover:text-gray-300"
              >
                Disconnect Flowsta account
              </button>
            ) : (
              <div class="bg-gray-900 border border-red-900/50 rounded-lg p-4">
                <p class="text-sm text-gray-300 mb-3">
                  Disconnect your Flowsta account? You can reconnect at any time.
                </p>
                <div class="flex gap-2">
                  <button
                    type="button"
                    data-testid="identity-disconnect-confirm"
                    onClick$={unlinkIdentity}
                    disabled={unlinking.value}
                    class="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-full text-sm"
                  >
                    {unlinking.value ? "Disconnecting..." : "Disconnect"}
                  </button>
                  <button
                    type="button"
                    onClick$={() => (confirmUnlink.value = false)}
                    class="bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium px-4 py-2 rounded-full text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Technical details (collapsed by default) */}
          <div>
            <button
              type="button"
              data-testid="identity-details-toggle"
              onClick$={() => (showDetails.value = !showDetails.value)}
              class="text-xs text-gray-500 hover:text-gray-400 flex items-center gap-1"
            >
              <span class={`transition-transform ${showDetails.value ? "rotate-90" : ""}`}>
                &#9654;
              </span>
              Technical details
            </button>
            {showDetails.value && (
              <div class="mt-2 bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
                <div>
                  <p class="text-xs text-gray-500 mb-1">This device's key</p>
                  <p class="font-mono text-xs text-gray-400 break-all" data-testid="identity-agent-key">
                    {agentKey.value}
                  </p>
                </div>
                <div>
                  <p class="text-xs text-gray-500 mb-1">Linked Vault key</p>
                  <p class="font-mono text-xs text-gray-400 break-all" data-testid="identity-vault-key">
                    {linkedVaultKey.value}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Not linked state ── */
        <div class="space-y-6" data-testid="identity-signed-out">
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
            <h2 class="text-lg font-semibold text-white mb-2">
              Connect your Flowsta account
            </h2>
            <p class="text-sm text-gray-400 mb-6 max-w-sm mx-auto">
              Signing in links this device to your Flowsta identity. Notes
              you write on the board then show as yours on every device you
              sign in on, and your private notes follow you there.
            </p>

            {/* Status messages */}
            {error.value && (
              <div class="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded-lg text-sm mb-4 text-left" data-testid="identity-error">
                {error.value}
                {error.value.includes("not running") && (
                  <p class="mt-2 text-gray-400">
                    Don't have Flowsta Vault?{" "}
                    <button
                      type="button"
                      onClick$={() => openExternal("https://flowsta.com/vault")}
                      class="text-indigo-400 hover:text-indigo-300 underline"
                      >
                      Download it at flowsta.com
                    </button>
                  </p>
                )}
              </div>
            )}

            {success.value && (
              <div class="bg-green-900/20 border border-green-800 text-green-300 px-4 py-2 rounded-lg text-sm mb-4" data-testid="identity-success">
                {success.value}
              </div>
            )}

            <button
              type="button"
              data-testid="identity-signin"
              onClick$={linkIdentity}
              disabled={linking.value || !agentKey.value}
              class="disabled:opacity-50 inline-block"
            >
              {linking.value ? (
                <span class="inline-flex items-center bg-gray-200 text-gray-700 font-medium px-6 py-2 rounded-full text-sm">
                  Connecting...
                </span>
              ) : (
                <img
                  src="/assets/flowsta-signin.svg"
                  alt="Sign in with Flowsta"
                  width={158}
                  height={36}
                  class="hover:opacity-80 transition-opacity"
                />
              )}
            </button>
            {linking.value && (
              <p class="text-sm text-indigo-300 mt-3" data-testid="identity-connecting">
                Check your Flowsta Vault app to approve the connection.
              </p>
            )}

            <p class="text-xs text-gray-600 mt-4">
              Flowsta Vault must be running and unlocked on this computer.{" "}
              <button
                type="button"
                onClick$={() => openExternal("https://flowsta.com/vault")}
                class="text-indigo-400 hover:text-indigo-300 underline"
                >
                Get Flowsta Vault
              </button>
            </p>
          </div>

          {/* Technical details (collapsed by default) */}
          <div>
            <button
              type="button"
              data-testid="identity-details-toggle"
              onClick$={() => (showDetails.value = !showDetails.value)}
              class="text-xs text-gray-500 hover:text-gray-400 flex items-center gap-1"
            >
              <span class={`transition-transform ${showDetails.value ? "rotate-90" : ""}`}>
                &#9654;
              </span>
              Technical details
            </button>
            {showDetails.value && (
              <div class="mt-2 bg-gray-900 border border-gray-800 rounded-lg p-4">
                <p class="text-xs text-gray-500 mb-1">This device's key</p>
                <p class="font-mono text-xs text-gray-400 break-all">
                  {agentKey.value || "Not available"}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
