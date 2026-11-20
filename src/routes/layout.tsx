// The frame around every page: the header, the start screens, the sign-in
// state and its banners, the Vault backup, and the update notices.
//
// The part worth understanding before you change anything is the sign-in
// state (`computeLinkState`): a profile is `linked`, `offline`, `mismatch`
// or `unlinked` (lib/context.ts says what each means), worked out in ONE
// place from the profile's own link file, the network and the live Vault,
// and handed to every page through context. Pages never work it out
// themselves.
//
// For a fork: keep this file. What you are likely to change is the header's
// links (add your pages) and the banners' wording. If your pages need to
// know whether a person can write, read `linkedContext`; do not add a
// second check of the Vault.
import { component$, Slot, useContextProvider, useSignal, useVisibleTask$, $ } from "@builder.io/qwik";
import { Link, useLocation, useNavigate } from "@builder.io/qwik-city";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { linkedContext, linkStateContext, displayNameContext, profilePictureContext, type LinkState } from "~/lib/context";
import { sanitizeImageSrc } from "~/lib/sanitize";
import { bindOpenProfile, CLIENT_ID, setSignInIntent, vaultLinkOptions } from "~/lib/signin";
import { forgetLinkToken, signInWithVault } from "~/lib/vault-link";
import { LINK_REFUSED_EVENT, vaultRefusalMessage } from "~/lib/errors";
import { getIdentityLink, revokeIdentityLink, identityLinkedOnNetwork, getCachedProfile, saveProfileCache } from "~/lib/holochain";
import { APP_NAME } from "~/lib/app";
import { getFlowstaLinkStatus } from "@flowsta/holochain";

/** What `probe_vault` (Rust) found: this user's Vault, unlocked first. */
interface VaultProbe {
  port: number;
  url: string;
  unlocked: boolean;
  initialized: boolean;
  agent_pub_key: string | null;
  display_name: string | null;
  profile_picture: string | null;
}
import { buildBackup, setBackupTriggersEnabled, reportBackupOutcome } from "~/lib/backup";


interface AppStatus {
  ready: boolean;
  /** This device's key. */
  agent_pub_key: string | null;
  conductor_status:
    | { status: "stopped" }
    | { status: "starting"; message: string }
    | { status: "ready"; admin_port: number; app_port: number }
    | { status: "error"; message: string };
  /** The person's own network is set up on this device. */
  my_notes_ready?: boolean;
  relaunched_into_identity?: boolean;
}

export default component$(() => {
  const status = useSignal<AppStatus | null>(null);
  const displayName = useSignal<string | null>(null);
  const profilePicture = useSignal<string | null>(null);
  const linked = useSignal(false);
  // Rich link state: 'linked' / 'offline' / 'mismatch' / 'unlinked'.
  // `linked.value` is permissive (linked || offline); the layout's banner
  // (further down) keys off `linkState.value === 'mismatch'` so individual
  // pages don't need to know about the account-changed flow.
  const linkState = useSignal<LinkState>("unlinked");
  // "Open as this identity" relaunched us into a profile that may not be
  // signed in yet. Start the sign-in once, so the person is left with only
  // the approval in the Vault.
  const autoSignInDone = useSignal(false);
  useContextProvider(linkedContext, linked);
  useContextProvider(linkStateContext, linkState);
  useContextProvider(displayNameContext, displayName);
  useContextProvider(profilePictureContext, profilePicture);
  const loc = useLocation();
  const nav = useNavigate();
  // The app's own updates: one downloaded and checked, waiting for a
  // restart; and, once after an update, what this copy was updated to.
  const updateReady = useSignal<{ version: string; notes_url: string; asks_password: boolean } | null>(null);
  // "Restart to update" under way: the step it is at (set on the click,
  // then from `update-stage`), or "failed" when the install did not happen.
  const updateStage = useSignal<"password" | "installing" | "restarting" | "failed" | null>(null);
  const updatedFrom = useSignal<{ version: string; to: string; notes_url: string } | null>(null);
  const disconnecting = useSignal(false);
  // Signed in on this device, but the network holds no link of this
  // device's key to the identity (a device whose local data was reset): other
  // people cannot see that what it writes is this person's. Asked for from the banner,
  // never in the background (a Vault dialog nobody started reads as the
  // Vault forgetting the app).
  const linkNeeded = useSignal(false);
  const linkConfirming = useSignal(false);
  // Why the Vault did not confirm it, in words for the banner.
  const linkConfirmError = useSignal<string | null>(null);
  // The Vault refused a call over this profile's link: it no longer knows
  // the link's token (the person removed the app in the Vault, or the
  // Vault was reset), or the link needs a token this profile does not
  // hold. Signing in again makes a new link; the banner offers it.
  const reconnectNeeded = useSignal(false);

  useVisibleTask$(({ cleanup }) => {
    let active = true;
    let stopAutoBackup: (() => void) | null = null;
    let unlistenStatus: (() => void) | null = null;

    // Listen for conductor-status events from the health monitor
    listen<AppStatus["conductor_status"]>("conductor-status", (event) => {
      const cs = event.payload;
      if (cs.status === "error") {
        status.value = {
          ready: false,
          agent_pub_key: status.value?.agent_pub_key ?? null,
          conductor_status: cs,
        };
      }
    }).then((unlisten) => {
      unlistenStatus = unlisten;
    });

    const unlisteners: (() => void)[] = [];
    invoke<{ ready: typeof updateReady.value; updated: typeof updatedFrom.value }>("update_status")
      .then((st) => {
        updateReady.value = st.ready;
        updatedFrom.value = st.updated;
      })
      .catch(() => {});
    // Null when the waiting download was dropped (automatic updates switched off).
    listen<typeof updateReady.value>("update-ready", (event) => {
      updateReady.value = event.payload;
    }).then((unlisten) => unlisteners.push(unlisten));
    listen<"password" | "installing" | "restarting">("update-stage", (event) => {
      updateStage.value = event.payload;
    }).then((unlisten) => unlisteners.push(unlisten));
    listen(LINK_REFUSED_EVENT, () => {
      reconnectNeeded.value = true;
    }).then((unlisten) => unlisteners.push(unlisten));

    const startBackup = async () => {
      // Backups run while a person is signed in here. The hourly run below
      // covers long sessions; the write triggers (lib/backup.ts) cover
      // "wrote a note, closed the laptop".
      setBackupTriggersEnabled(true);
      if (stopAutoBackup) return; // Already running
      try {
        const { startAutoBackup } = await import("@flowsta/holochain");
        const pin = await vaultLinkOptions();
        stopAutoBackup = startAutoBackup({
          clientId: CLIENT_ID,
          appName: APP_NAME,
          ...pin,
          intervalMinutes: 60,
          // The person's own notes, gathered on the Rust side (notes.rs).
          getData: buildBackup,
          onSuccess: (r) => reportBackupOutcome(true, `${r.dataSize} bytes`),
          onError: (e) => reportBackupOutcome(false, vaultRefusalMessage(e) ?? e.message),
        });
      } catch {
        // The SDK did not load: the next tick tries again.
      }
    };

    const stopBackup = () => {
      setBackupTriggersEnabled(false);
      if (stopAutoBackup) {
        stopAutoBackup();
        stopAutoBackup = null;
      }
    };

    // ONE computation of the sign-in state, for both loops below.
    //
    // What it weighs, in order:
    //   - the profile's own link file (`getIdentityLink`): the identity this
    //     profile is signed in as. Against the identity the Vault holds NOW,
    //     it is the main signal;
    //   - the network: whether a link record for this device's key is there;
    //   - the Vault: whether it is there, unlocked, and what it says.
    const computeLinkState = async (agentPubKey: string): Promise<LinkState> => {
      const dhtLinked = await identityLinkedOnNetwork(agentPubKey).catch(() => false);
      const localLink = await getIdentityLink().catch(() => null);
      if (!dhtLinked && !localLink) return "unlinked";

      // Primary: compare the linked identity against whoever is actually
      // unlocked right now.
      // The same probe the Rust identity gate uses: three ports, another
      // OS user's Vault ignored, the unlocked one preferred - the page can
      // never judge against a different Vault than the gate does.
      let vaultLive: VaultProbe | null = null;
      try {
        vaultLive = await invoke<VaultProbe | null>("probe_vault");
      } catch {
        // Vault not reachable
      }
      if (vaultLive?.unlocked && vaultLive.agent_pub_key && localLink) {
        // The Vault's identity against the one this profile is signed in
        // as is the whole question. Equal = linked, whatever the Vault's own
        // list of connected apps says: that list is erased by a Vault reset
        // and rebuilt lazily.
        if (vaultLive.agent_pub_key === localLink.vault_agent_pub_key) {
          return "linked";
        }
        return "mismatch";
      }
      if (!vaultLive) return "offline";
      // A Vault that is locked, or holds no identity at all (just reset,
      // mid-setup), cannot vouch for or against anyone: no banner.
      // Unlocked and naming nobody: the Vault names its identity only to an
      // app connected under it, so it may hold one this app has never been
      // connected under. Asked about the identity this profile IS signed in
      // as, it says plainly when it holds another.
      if (vaultLive.unlocked && vaultLive.initialized !== false && !vaultLive.agent_pub_key && localLink) {
        const another = await invoke<boolean>("vault_holds_another_identity", { appAgentPubKey: agentPubKey }).catch(() => false);
        if (another) return "mismatch";
      }
      if (!vaultLive.unlocked || vaultLive.initialized === false || !vaultLive.agent_pub_key) {
        return "offline";
      }

      const vaultStatus = await getFlowstaLinkStatus({
        clientId: CLIENT_ID,
        localAgentPubKey: agentPubKey,
        ...(await vaultLinkOptions()),
      }).catch(() => ({ state: "offline" as const }));
      if (vaultStatus.state === "linked") return "linked";
      if (vaultStatus.state === "offline") return "offline";
      // Vault is running and says no link for this app's agent - the user
      // unlinked deliberately or switched accounts. Surface the choice via
      // the banner; never auto-revoke their data.
      return "mismatch";
    };

    // Once a session: does the network link this device's key to the
    // identity? Asked again on the link loop's ticks until it answers.
    let networkLinkChecked = false;
    let networkLinkChecking = false;
    const checkNetworkLink = async (linkKey: string) => {
      if (networkLinkChecked || networkLinkChecking || linkState.value !== "linked") return;
      networkLinkChecking = true;
      try {
        const ok = await identityLinkedOnNetwork(linkKey);
        networkLinkChecked = true;
        linkNeeded.value = !ok;
      } catch {
        // The network did not answer: the next tick asks again.
      } finally {
        networkLinkChecking = false;
      }
    };

    const poll = async () => {
      while (active) {
        try {
          const s = await invoke<AppStatus>("get_app_status");
          status.value = s;
          if (s.ready) {
            const linkKey = s.agent_pub_key;
            if (linkKey) {
              // The SDK takes the open profile's identity and link token
              // before the first call to the Vault.
              await bindOpenProfile();
              const state = await computeLinkState(linkKey);
              linkState.value = state;
              // Everyday writes need a signed-in device, not a live Vault:
              // `offline` (signed in, the Vault locked or closed) can write.
              // `mismatch` and `unlinked` are read-only. The Rust side
              // enforces this whatever the page shows.
              linked.value = state === "linked" || state === "offline";
              if (
                s.relaunched_into_identity &&
                state === "unlinked" &&
                !autoSignInDone.value
              ) {
                autoSignInDone.value = true;
                try {
                  const live = await invoke<VaultProbe | null>("probe_vault");
                  // The Vault names its identity only once the app is
                  // connected under it: unlocked is enough to start.
                  if (live?.unlocked && live.initialized !== false) {
                    setSignInIntent({ autoLink: true });
                    nav("/identity/");
                  }
                } catch {
                  // Vault not reachable: the Identity page still offers it.
                }
              }

              checkNetworkLink(linkKey);
            }

            // The profile: the cached name and picture show while signed in
            // (Vault open or not); the cache is refreshed only from the
            // Vault of the SAME identity (the Rust side refuses otherwise).
            if (linkState.value === "linked" || linkState.value === "offline") {
              try {
                const cached = await getCachedProfile();
                if (cached) {
                  if (cached.display_name) displayName.value = cached.display_name;
                  if (cached.profile_picture) profilePicture.value = cached.profile_picture;
                }
              } catch {
                // No cache yet
              }
            }
            if (linkState.value === "linked") {
              try {
                const vault = await invoke<VaultProbe | null>("probe_vault");
                if (vault) {
                  if (vault.display_name) {
                    displayName.value = vault.display_name;
                    if (vault.profile_picture)
                      profilePicture.value = vault.profile_picture;
                    // Save to cache for next startup (Rust re-verifies the
                    // identity before writing)
                    await saveProfileCache(
                      vault.display_name,
                      vault.profile_picture || null,
                    ).catch(() => {});
                  }
                }
              } catch {
                // The Vault is not running: the cached profile, if any, is already loaded.
              }
            }
            // Backups run for a signed-in device, `offline` included: the
            // Vault takes a backup while locked, once it was unlocked.
            if (linkState.value === "linked" || linkState.value === "offline") {
              startBackup();
            }

            break;
          }
        } catch (e) {
          console.error("Status poll failed:", e);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };

    poll();

    // Poll link status so header updates after link/unlink on identity page
    const linkPoll = setInterval(async () => {
      const s = status.value;
      const linkKey = s?.agent_pub_key;
      if (!s?.ready || !linkKey) return;
      try {
        // Same state-machine as the initial poll, recompute on every tick.
        // The user could have locked / unlocked Vault, switched accounts,
        // or unlinked from the Vault UI at any moment, and the layout
        // banner needs to reflect it within the polling cadence.
        const wasLinked = linked.value;
        const nextState = await computeLinkState(linkKey);

        linkState.value = nextState;
        const nowLinked = nextState === "linked";
        // Signed-in installs are writable without an unlock; only
        // mismatch/unlinked are read-only.
        linked.value = nowLinked || nextState === "offline";

        // Backups follow writability (both are idempotent to call).
        if (linked.value) startBackup();
        else stopBackup();

        // The network's link: asked once signed in (again after a switch
        // or a sign-out, which can change the answer).
        if (nowLinked) checkNetworkLink(linkKey);
        else {
          networkLinkChecked = false;
          linkNeeded.value = false;
        }
        // Signed out: there is no link left to connect again.
        if (nextState === "unlinked") reconnectNeeded.value = false;

        // Fetch profile when linked but profile is missing. Cache display
        // is fine in `offline` too; refreshing the cache is linked-only
        // (Rust refuses it otherwise).
        if ((nowLinked || nextState === "offline") && !displayName.value) {
          try {
            const cached = await getCachedProfile();
            if (cached?.display_name) {
              displayName.value = cached.display_name;
              if (cached.profile_picture) profilePicture.value = cached.profile_picture;
            }
          } catch {}
          if (nowLinked && !displayName.value) {
            try {
              const vault = await invoke<VaultProbe | null>("probe_vault");
              if (vault) {
                if (vault.display_name) {
                  displayName.value = vault.display_name;
                  if (vault.profile_picture)
                    profilePicture.value = vault.profile_picture;
                  await saveProfileCache(
                    vault.display_name,
                    vault.profile_picture || null,
                  ).catch(() => {});
                }
              }
            } catch {
              // Vault not running
            }
          }
        }

        // Clear profile when going to a fully-unlinked state. In `mismatch`
        // we deliberately keep the cached display name/picture so the user
        // can see who they used to be signed in as, but the header renders
        // them with a "stale" treatment.
        if (wasLinked && nextState === "unlinked") {
          displayName.value = null;
          profilePicture.value = null;
          await saveProfileCache(null, null).catch(() => {});
        }
      } catch {
        // Ignore errors
      }
    }, 15000);

    cleanup(() => {
      active = false;
      clearInterval(linkPoll);
      stopBackup();
      if (unlistenStatus) unlistenStatus();
      unlisteners.forEach((unlisten) => unlisten());
    });
  });

  /**
   * Disconnect from the banner: the Vault holds another identity and the
   * person wants this profile signed out. The link is removed here and
   * revoked on the network; their notes stay.
   */
  const handleDisconnect = $(async () => {
    if (disconnecting.value) return;
    disconnecting.value = true;
    try {
      await revokeIdentityLink().catch(() => {});
      // The profile has no link now: its link token and the SDK's binding
      // go with it. The Vault is not asked to remove the app here: it holds
      // another identity, and the one that was signed in keeps its entry
      // until the person disconnects it there.
      const s = status.value;
      await forgetLinkToken(s?.agent_pub_key ?? null);
      await bindOpenProfile();
      reconnectNeeded.value = false;
      await saveProfileCache(null, null).catch(() => {});
      displayName.value = null;
      profilePicture.value = null;
      linkState.value = "unlinked";
      linked.value = false;
    } finally {
      disconnecting.value = false;
    }
  });

  // The link banners' action (confirm this device; connect again): the
  // Vault signs the link of this device's key, it is written to the
  // network, and the profile keeps the link's token.
  // commit_identity_link refuses any identity but the one this install is
  // linked to.
  const handleConfirmLink = $(async () => {
    const s = status.value;
    const linkKey = s?.agent_pub_key;
    if (!linkKey || linkConfirming.value) return;
    const notConfirmed = "Your Vault did not confirm it. Try again with your Vault open and unlocked.";
    linkConfirming.value = true;
    linkConfirmError.value = null;
    try {
      if (await signInWithVault(linkKey)) {
        linkNeeded.value = false;
        reconnectNeeded.value = false;
      } else {
        linkConfirmError.value = notConfirmed;
      }
    } catch (e) {
      linkConfirmError.value = vaultRefusalMessage(e) ?? notConfirmed;
    } finally {
      linkConfirming.value = false;
    }
  });
  // A switch mid-session: relaunch, and the app opens on the profile of
  // the identity the Vault holds now (picked at launch) instead of staying
  // read-only under the old name.
  const handleRestartIntoIdentity = $(async () => {
    await invoke("restart_app").catch(() => {});
  });

  const isActive = (path: string) => loc.url.pathname === path;

  return (
    <div class="min-h-screen flex flex-col">
      <header class="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between">
        <div class="flex items-center gap-6">
          <Link href="/" class="text-xl font-bold text-white hover:text-indigo-400">
            {APP_NAME}
          </Link>
          {status.value?.ready && (
            <nav class="flex gap-4">
              <Link
                href="/"
                data-testid="nav-notes"
                class={`text-sm ${isActive("/") ? "text-indigo-400 font-medium" : "text-gray-400 hover:text-gray-200"}`}
              >
                Notes
              </Link>
              <Link
                href="/identity/"
                data-testid="nav-settings"
                class={`text-sm ${loc.url.pathname.startsWith("/identity/") || loc.url.pathname.startsWith("/settings/") ? "text-indigo-400 font-medium" : "text-gray-400 hover:text-gray-200"}`}
              >
                Settings
              </Link>
            </nav>
          )}
        </div>
        <div class="flex items-center gap-3">
        {updateReady.value && (
          <button
            type="button"
            data-testid="nav-restart-to-update"
            disabled={updateStage.value !== null && updateStage.value !== "failed"}
            title={
              updateReady.value.asks_password
                ? `Installs ${APP_NAME} ${updateReady.value.version}, then closes and opens it again. Your computer asks for your password first.`
                : `Installs ${APP_NAME} ${updateReady.value.version}, then closes and opens it again.`
            }
            class="flex items-center gap-2 rounded-full bg-indigo-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-default disabled:bg-indigo-600/80"
            onClick$={async () => {
              // Said at once, before the password prompt or Holochain's stop.
              updateStage.value = updateReady.value!.asks_password ? "password" : "installing";
              try {
                await invoke("restart_to_update");
              } catch (e) {
                console.error("Update did not install:", e);
                updateStage.value = "failed";
              }
            }}
          >
            {updateStage.value !== null && updateStage.value !== "failed" && (
              <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            )}
            {updateStage.value === "restarting"
              ? "Reopening..."
              : updateStage.value !== null && updateStage.value !== "failed"
                ? "Installing..."
                : "Restart to update"}
          </button>
        )}
        {status.value?.ready &&
          status.value.agent_pub_key &&
          (linkState.value === "unlinked" ? (
            <button
              type="button"
              data-testid="nav-signin"
              onClick$={() => {
                setSignInIntent({ autoLink: true });
                nav("/identity/");
              }}
              class="bg-transparent border-0 p-0 cursor-pointer"
            >
              <img
                src="/assets/flowsta-signin.svg"
                alt="Sign in with Flowsta"
                width={158}
                height={36}
                class="hover:opacity-80 transition-opacity"
              />
            </button>
          ) : (
            // linked / offline / mismatch: the profile. In `mismatch` it is
            // grayed out, and the banner below explains.
            <div
              class="flex items-center gap-2"
              data-testid="nav-profile"
              title={
                linkState.value === "mismatch"
                  ? "The identity signed in here. Your Vault holds another one now: see the notice below."
                  : undefined
              }
            >
              {displayName.value && (
                <span
                  data-testid="nav-profile-name"
                  class={[
                    "text-sm",
                    linkState.value === "mismatch"
                      ? "text-gray-500 line-through"
                      : "text-gray-300",
                  ].join(" ")}
                >
                  {displayName.value}
                </span>
              )}
              {sanitizeImageSrc(profilePicture.value) ? (
                <img
                  src={sanitizeImageSrc(profilePicture.value)!}
                  alt="Profile"
                  class={[
                    "h-8 w-8 rounded-full object-cover border border-gray-600",
                    linkState.value === "mismatch" ? "opacity-40 grayscale" : "",
                  ].join(" ")}
                  width={32}
                  height={32}
                />
              ) : (
                <div
                  class={[
                    "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium text-white",
                    linkState.value === "mismatch" ? "bg-gray-700" : "bg-indigo-600",
                  ].join(" ")}
                >
                  {displayName.value
                    ? displayName.value.charAt(0).toUpperCase()
                    : "F"}
                </div>
              )}
            </div>
          ))}
        </div>
      </header>

      <main class="flex-1 p-6">
        {!status.value ? (
          <div class="flex items-center justify-center h-64" data-testid="nav-connecting">
            <div class="text-gray-400">Connecting...</div>
          </div>
        ) : !status.value.ready ? (
          <div class="flex flex-col items-center justify-center min-h-64 py-8 gap-4">
            {status.value.conductor_status.status === "error" ? (
              <>
                <div class="w-12 h-12 rounded-full bg-red-900/40 flex items-center justify-center">
                  <svg class="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2}>
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div class="text-center max-w-md" data-testid="nav-connection-lost">
                  <h2 class="text-lg font-semibold text-white mb-1">Holochain is not running</h2>
                  <p class="text-gray-400 text-sm mb-4">
                    {status.value.conductor_status.message}
                  </p>
                  <button
                    type="button"
                    onClick$={() => window.close()}
                    class="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-full text-sm font-medium"
                  >
                    Close App
                  </button>
                  <p class="text-gray-600 text-xs mt-2">Close the app and open it again to start it.</p>
                </div>
              </>
            ) : (
              <>
                <div class="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                <div class="text-gray-400" data-testid="nav-starting">
                  {status.value.conductor_status.status === "starting"
                    ? status.value.conductor_status.message
                    : "Starting Holochain..."}
                </div>
                <p class="text-gray-600 text-xs max-w-xs text-center">
                  Holochain runs on this computer and is starting up. The first start takes about half a minute, later ones a few seconds.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            {/* The Vault holds another identity than the one signed in
                here. Two ways out: open the app as the identity the Vault
                holds now (its own profile, its own notes), or disconnect
                this profile on purpose. Nothing is ever disconnected by
                itself. */}
            {linkState.value === "mismatch" && (
              <div class="bg-amber-900/30 border border-amber-800/50 rounded-lg px-4 py-3 mb-4" data-testid="nav-mismatch-banner">
                <div class="flex items-start gap-3">
                  <svg
                    class="h-5 w-5 shrink-0 text-amber-400 mt-0.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width={2}
                    aria-hidden="true"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                    />
                  </svg>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-amber-200">
                      Your Vault is signed in as someone else
                    </p>
                    <p class="mt-1 text-xs text-amber-300/90">
                      This profile is signed in as a different Flowsta
                      identity. Everything here is safe. Open the app as the
                      identity your Vault holds now (with its own notes), or
                      switch your Vault back.
                    </p>
                    <div class="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick$={handleRestartIntoIdentity}
                        class="inline-flex items-center rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
                      >
                        Open as this identity
                      </button>
                      <button
                        type="button"
                        disabled={disconnecting.value}
                        onClick$={handleDisconnect}
                        class="inline-flex items-center rounded-md border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                      >
                        {disconnecting.value ? "Disconnecting..." : "Disconnect"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* The Vault no longer has this profile's link (or the link
                needs a token the profile does not hold): signing in again
                makes a new one. The mismatch banner outranks it, and it
                stands in for the link banner below (the same sign-in
                settles both). */}
            {reconnectNeeded.value &&
              (linkState.value === "linked" || linkState.value === "offline") && (
                <div class="bg-indigo-900/30 border border-indigo-800/50 rounded-lg px-4 py-3 mb-4" data-testid="nav-reconnect-banner">
                  <p class="text-sm font-medium text-indigo-200">
                    Connect to your Vault again
                  </p>
                  <p class="mt-1 text-xs text-indigo-300/90">
                    Your Vault no longer recognizes this app's connection, so
                    backups are on hold. Your notes are unchanged. Connect
                    again and approve it in your Vault.
                  </p>
                  {linkConfirmError.value && (
                    <p class="mt-1 text-xs text-amber-300/90">
                      {linkConfirmError.value}
                    </p>
                  )}
                  <div class="mt-3">
                    <button
                      type="button"
                      onClick$={handleConfirmLink}
                      disabled={linkConfirming.value}
                      data-testid="nav-reconnect-confirm"
                      class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
                    >
                      {linkConfirming.value ? "Waiting for your Vault..." : "Connect again"}
                    </button>
                  </div>
                </div>
              )}

            {linkNeeded.value && !reconnectNeeded.value && linkState.value === "linked" && (
              <div class="bg-indigo-900/30 border border-indigo-800/50 rounded-lg px-4 py-3 mb-4" data-testid="nav-link-banner">
                <p class="text-sm font-medium text-indigo-200">
                  Confirm this device in your Vault
                </p>
                <p class="mt-1 text-xs text-indigo-300/90">
                  Once, so other people can see that the notes you write on
                  this device are yours.
                </p>
                {linkConfirmError.value && (
                  <p class="mt-1 text-xs text-amber-300/90">
                    {linkConfirmError.value}
                  </p>
                )}
                <div class="mt-3">
                  <button
                    type="button"
                    onClick$={handleConfirmLink}
                    disabled={linkConfirming.value}
                    data-testid="nav-link-confirm"
                    class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
                  >
                    {linkConfirming.value ? "Waiting for your Vault..." : "Confirm in Vault"}
                  </button>
                </div>
              </div>
            )}

            <Slot />
          </>
        )}
      </main>

      {/* The app's messages, one stack at the bottom right, each on a solid
          panel so nothing behind shows through. Dialogs (z-50) cover it. */}
      <div class="pointer-events-none fixed bottom-6 right-6 z-40 flex w-80 flex-col gap-3">
      {/* Once after an update: what changed */}
      {updatedFrom.value && (
        <div data-testid="nav-updated" class="pointer-events-auto flex items-start gap-3 rounded-lg border border-indigo-500/40 bg-indigo-950 px-4 py-3 shadow-xl">
          <div class="min-w-0 flex-1">
            <p class="text-sm text-indigo-200">Updated to {APP_NAME} {updatedFrom.value.to}</p>
            {updatedFrom.value.notes_url && (
              <button
                type="button"
                class="mt-0.5 text-sm font-medium text-indigo-300 underline hover:text-indigo-200"
                onClick$={async () => {
                  const { open } = await import("@tauri-apps/plugin-shell");
                  await open(updatedFrom.value!.notes_url);
                }}
              >
                What changed
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            class="shrink-0 text-indigo-300 hover:text-white"
            onClick$={async () => {
              updatedFrom.value = null;
              await invoke("dismiss_updated").catch(() => {});
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* "Restart to update" under way: what happens next */}
      {updateReady.value && updateStage.value && (
        <div
          class={`pointer-events-auto flex items-start gap-2.5 rounded-lg border px-4 py-3 shadow-xl ${
            updateStage.value === "failed" ? "border-red-500/40 bg-red-950" : "border-indigo-500/40 bg-gray-800"
          }`}
        >
          {updateStage.value !== "failed" && (
            <div class="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
          )}
          <div class="min-w-0 flex-1">
            {updateStage.value === "password" ? (
              <>
                <p class="text-sm text-gray-100">Installing {APP_NAME} {updateReady.value.version}</p>
                <p class="mt-0.5 text-xs text-gray-400">Your computer asks for your password to install it. Then the app closes and opens again.</p>
              </>
            ) : updateStage.value === "installing" ? (
              <>
                <p class="text-sm text-gray-100">Installing {APP_NAME} {updateReady.value.version}</p>
                <p class="mt-0.5 text-xs text-gray-400">Then the app closes and opens again.</p>
              </>
            ) : updateStage.value === "restarting" ? (
              <p class="text-sm text-gray-100">Installed. The app is closing and opening again.</p>
            ) : (
              <>
                <p class="text-sm text-red-200">{APP_NAME} {updateReady.value.version} was not installed</p>
                <p class="mt-0.5 text-xs text-gray-400">Nothing changed. Press Restart to update to try again.</p>
              </>
            )}
          </div>
          {updateStage.value === "failed" && (
            <button type="button" aria-label="Dismiss" class="shrink-0 text-gray-400 hover:text-white" onClick$={() => (updateStage.value = null)}>
              ×
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
});
