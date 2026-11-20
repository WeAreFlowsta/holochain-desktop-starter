// Settings > Updates: the switch for automatic updates, and what the app
// says when this copy cannot update itself.
//
// For a fork: keep this page. How updates are checked and installed is
// src-tauri/src/updater.rs; how a release is made is RELEASING.md.
import { component$, useSignal, useVisibleTask$, $ } from "@builder.io/qwik";
import { invoke } from "@tauri-apps/api/core";
import { SettingsTabs } from "~/components/settings-tabs/settings-tabs";

interface UpdateSettings {
  auto: boolean;
  version: string;
  notice: string | null;
  can_update: boolean;
  has_signer: boolean;
}

export default component$(() => {
  // The app's own updates: automatic (default) or off.
  const updates = useSignal<UpdateSettings | null>(null);
  const busy = useSignal(false);

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    try {
      updates.value = await invoke<UpdateSettings>("update_status");
    } catch (err) {
      console.error("Failed to read update settings:", err);
    }
  });

  const setAuto = $(async (auto: boolean) => {
    busy.value = true;
    try {
      updates.value = await invoke<UpdateSettings>("set_update_prefs", { auto });
    } catch (err) {
      console.error("Failed to change update settings:", err);
    } finally {
      busy.value = false;
    }
  });

  return (
    <div class="max-w-xl mx-auto">
      <SettingsTabs />

      {updates.value && (
        <div class="bg-gray-900 border border-gray-800 rounded-lg p-6" data-testid="updates-card">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="mb-2 text-lg font-semibold text-white">Updates</h2>
              <p class="text-sm text-gray-400">
                Keep the app up to date automatically. A new version
                downloads in the background and installs when you press
                "Restart to update".
              </p>
              {!updates.value.has_signer && (
                <p class="mt-2 text-sm text-amber-200/90" data-testid="updates-no-signer">
                  This build does not update itself: no release signer is set
                  in it yet. New versions are on the releases page.
                </p>
              )}
              {updates.value.has_signer && !updates.value.can_update && !updates.value.notice && (
                <p class="mt-2 text-sm text-amber-200/90">
                  This copy was not installed from a package the app can
                  replace, so it does not update itself. New versions are on
                  the releases page.
                </p>
              )}
              {updates.value.notice && <p class="mt-2 text-sm text-amber-200/90">{updates.value.notice}</p>}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={updates.value.auto}
              aria-label="Update automatically"
              data-testid="updates-auto"
              disabled={busy.value}
              onClick$={() => setAuto(!updates.value!.auto)}
              class={{
                "relative mt-1 inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full p-0 transition-colors": true,
                "bg-indigo-600": updates.value.auto,
                "bg-gray-600": !updates.value.auto,
                "opacity-60": busy.value,
              }}
            >
              <span
                class={{
                  "inline-block h-4 w-4 transform rounded-full bg-white transition-transform": true,
                  "translate-x-6": updates.value.auto,
                  "translate-x-1": !updates.value.auto,
                }}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
