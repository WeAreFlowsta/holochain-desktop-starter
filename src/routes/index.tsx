// Notes: the one page of the example app. THIS IS THE PAGE TO MAKE YOURS.
//
// Two tabs over the same form and the same list. A tab only says which
// network the calls mean (`Place` in lib/holochain.ts):
//   - "The board": the shared network. Everyone reads it; a note is
//     changed on the device that wrote it.
//   - "My notes": the person's own network. Only their devices are on it,
//     and any of them changes any note.
//
// "My notes" also offers to bring notes back from the person's Vault
// backup when the backup holds notes this device does not (lib/restore.ts).
//
// Everything here goes through lib/holochain.ts; nothing talks to
// Holochain from the page. Writing needs a signed-in device (the Rust side
// checks it whatever the page shows).
import { component$, useContext, useSignal, useVisibleTask$, $ } from "@builder.io/qwik";
import { invoke } from "@tauri-apps/api/core";
import { linkedContext, linkStateContext } from "~/lib/context";
import { formatInvokeError } from "~/lib/errors";
import { countOfNotes, findRestorable, missingFromBackups, restoreNotes, type BackedUpNote } from "~/lib/restore";
import { createNote, deleteNote, editNote, getMyAgentSet, getNotes, setUpMyNotes, MY_NOTES_NOT_SET_UP, type Note, type Place } from "~/lib/holochain";

const MAX_CHARS: Record<Place, number> = { board: 2000, my_notes: 20000 };

/** "3 min ago", "2 h ago", then the date. `at`: microseconds since 1970. */
export function whenWritten(at: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - at / 1000) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return new Date(at / 1000).toLocaleDateString();
}

export default component$(() => {
  const linked = useContext(linkedContext);
  const linkState = useContext(linkStateContext);
  const place = useSignal<Place>("board");
  const notes = useSignal<Note[]>([]);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);
  // "My notes" before the person's own network is on this device.
  const needsSetUp = useSignal(false);
  const settingUp = useSignal(false);
  const setUpError = useSignal<string | null>(null);
  // This device's key, and every key that is this person (their other
  // devices too): "is this note mine?" and "can I change it here?".
  const myKey = useSignal<string | null>(null);
  const myKeys = useSignal<string[]>([]);
  const draft = useSignal("");
  const saving = useSignal(false);
  const editing = useSignal<string | null>(null);
  const editText = useSignal("");
  const now = useSignal(Date.now());
  // Private notes the Vault backup holds and this device does not.
  const restorable = useSignal<BackedUpNote[]>([]);
  const restoring = useSignal(false);
  const restored = useSignal<number | null>(null);
  const restoreError = useSignal<string | null>(null);

  const load = $(async (showSpinner: boolean) => {
    if (showSpinner) loading.value = true;
    const asked = place.value;
    try {
      const list = await getNotes(asked);
      // The answer of a tab the person has left is not shown.
      if (asked !== place.value) return;
      notes.value = list;
      needsSetUp.value = false;
      error.value = null;
      // A note that has arrived from another device since the backup was
      // read is no longer offered.
      if (restorable.value.length > 0) restorable.value = asked === "my_notes" ? missingFromBackups([{ my_notes: restorable.value }], list) : [];
    } catch (e) {
      if (asked !== place.value) return;
      const message = formatInvokeError(e, "The notes could not be read.");
      if (message === MY_NOTES_NOT_SET_UP) {
        needsSetUp.value = true;
        notes.value = [];
        error.value = null;
      } else {
        error.value = message;
      }
    } finally {
      if (asked === place.value) loading.value = false;
    }
  });

  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(({ cleanup }) => {
    const refresh = async () => {
      now.value = Date.now();
      try {
        const status = await invoke<{ agent_pub_key: string | null }>("get_app_status");
        myKey.value = status.agent_pub_key;
        myKeys.value = await getMyAgentSet();
      } catch {
        // Still starting: the next tick asks again.
      }
      await load(false);
    };
    load(true).then(refresh);
    // Other people's notes, and this person's from their other devices,
    // arrive over the network: read again every ten seconds.
    const timer = setInterval(refresh, 10_000);
    cleanup(() => clearInterval(timer));
  });

  // Read the Vault's backups once when the private notes are opened (the
  // Vault answers only while it is open and unlocked; when it does not,
  // there is nothing to offer).
  const lookInBackup = $(async () => {
    if (place.value !== "my_notes" || needsSetUp.value || linkState.value !== "linked") return;
    const found = await findRestorable(notes.value);
    if (place.value === "my_notes") restorable.value = found;
  });

  const restore = $(async () => {
    if (restoring.value || restorable.value.length === 0) return;
    restoring.value = true;
    restoreError.value = null;
    try {
      restored.value = await restoreNotes(restorable.value);
      restorable.value = [];
      await load(false);
    } catch (e) {
      restoreError.value = formatInvokeError(e, "The notes were not restored.");
    } finally {
      restoring.value = false;
    }
  });

  const choose = $(async (next: Place) => {
    if (place.value === next) return;
    place.value = next;
    notes.value = [];
    editing.value = null;
    error.value = null;
    needsSetUp.value = false;
    setUpError.value = null;
    restorable.value = [];
    restored.value = null;
    restoreError.value = null;
    await load(true);
    await lookInBackup();
  });

  const save = $(async () => {
    const text = draft.value.trim();
    if (!text || saving.value) return;
    saving.value = true;
    error.value = null;
    try {
      await createNote(place.value, text);
      draft.value = "";
      await load(false);
    } catch (e) {
      error.value = formatInvokeError(e, "The note was not saved.");
    } finally {
      saving.value = false;
    }
  });

  const saveEdit = $(async (id: string) => {
    const text = editText.value.trim();
    if (!text) return;
    error.value = null;
    try {
      await editNote(place.value, id, text);
      editing.value = null;
      await load(false);
    } catch (e) {
      error.value = formatInvokeError(e, "The change was not saved.");
    }
  });

  const remove = $(async (id: string) => {
    error.value = null;
    try {
      await deleteNote(place.value, id);
      await load(false);
    } catch (e) {
      error.value = formatInvokeError(e, "The note was not deleted.");
    }
  });

  const setUp = $(async () => {
    if (settingUp.value) return;
    settingUp.value = true;
    setUpError.value = null;
    try {
      await setUpMyNotes();
      await load(true);
      await lookInBackup();
    } catch (e) {
      setUpError.value = formatInvokeError(e, "Your private notes could not be set up.");
    } finally {
      settingUp.value = false;
    }
  });

  const tab = (which: Place, label: string, testid: string) => (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={place.value === which}
      onClick$={() => choose(which)}
      class={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
        place.value === which ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-gray-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div class="max-w-2xl mx-auto">
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-2xl font-bold">Notes</h1>
        <div class="flex gap-1 bg-gray-900 rounded-lg p-1 w-fit">
          {tab("board", "The board", "notes-tab-board")}
          {tab("my_notes", "My notes", "notes-tab-mine")}
        </div>
      </div>
      <p class="text-sm text-gray-500 mb-5" data-testid="notes-about">
        {place.value === "board"
          ? "Everyone using this app can read the board. A note can be edited or deleted only on the device it was written on."
          : "Only you can read these. They are kept on your own devices and nowhere else."}
      </p>

      {error.value && (
        <div class="bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-3 mb-4 text-sm text-red-300" data-testid="notes-error">
          {error.value}
        </div>
      )}

      {/* Not signed in: reading works, writing asks for the sign-in. */}
      {!linked.value && (
        <div class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 mb-5" data-testid="notes-signed-out">
          <p class="text-sm text-gray-300">
            {linkState.value === "mismatch"
              ? "Your Vault holds a different identity than the one signed in here, so notes are read-only for now."
              : place.value === "board"
                ? "Sign in with Flowsta to write on the board."
                : "Sign in with Flowsta to keep private notes."}
          </p>
        </div>
      )}

      {/* My notes: the Vault backup holds notes this device does not. */}
      {linked.value && place.value === "my_notes" && !needsSetUp.value && restorable.value.length > 0 && (
        <div class="bg-gray-900 border border-indigo-800/50 rounded-lg px-5 py-4 mb-5" data-testid="notes-restore">
          <h2 class="text-base font-semibold text-white mb-1">
            Your Vault backup has {countOfNotes(restorable.value.length)} that {restorable.value.length === 1 ? "is" : "are"} not on this device
          </h2>
          <p class="text-sm text-gray-400 mb-3">
            If another of your devices has {restorable.value.length === 1 ? "it, it arrives" : "them, they arrive"} by {restorable.value.length === 1 ? "itself" : "themselves"} when
            that device is on. If you no longer have one, restore from the backup.
          </p>
          {restoreError.value && (
            <p class="text-sm text-amber-300 mb-3" data-testid="notes-restore-error">
              {restoreError.value}
            </p>
          )}
          <div class="flex justify-end">
            <button
              type="button"
              data-testid="notes-restore-go"
              disabled={restoring.value}
              onClick$={restore}
              class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white px-4 py-2 rounded-full text-sm font-medium"
            >
              {restoring.value ? "Restoring..." : `Restore ${countOfNotes(restorable.value.length)}`}
            </button>
          </div>
        </div>
      )}
      {place.value === "my_notes" && restored.value !== null && restored.value > 0 && (
        <p class="text-sm text-emerald-400 mb-5" data-testid="notes-restored">
          {countOfNotes(restored.value)} restored from your Vault backup.
        </p>
      )}

      {/* My notes, before this device has joined the person's own network. */}
      {linked.value && place.value === "my_notes" && needsSetUp.value ? (
        <div class="bg-gray-900 border border-gray-800 rounded-lg px-5 py-5" data-testid="notes-set-up">
          <h2 class="text-base font-semibold text-white mb-1">Set up your private notes on this device</h2>
          <p class="text-sm text-gray-400 mb-4">
            Your Flowsta Vault gives this app a secret that only your devices have. With it, this device joins a private network of your own
            devices. Your Vault needs to be open and unlocked for this, once.
          </p>
          {setUpError.value && (
            <p class="text-sm text-amber-300 mb-3" data-testid="notes-set-up-error">
              {setUpError.value}
            </p>
          )}
          <div class="flex justify-end">
            <button
              type="button"
              data-testid="notes-set-up-go"
              disabled={settingUp.value}
              onClick$={setUp}
              class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white px-4 py-2 rounded-full text-sm font-medium"
            >
              {settingUp.value ? "Setting up..." : "Set up private notes"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {linked.value && (
            <div class="mb-6">
              <textarea
                data-testid="notes-text"
                rows={3}
                maxLength={MAX_CHARS[place.value]}
                placeholder={place.value === "board" ? "Write something for everyone to read" : "Write a note to yourself"}
                value={draft.value}
                onInput$={(_, el) => (draft.value = el.value)}
                class="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-indigo-500 focus:outline-none"
              />
              <div class="mt-2 flex justify-end">
                <button
                  type="button"
                  data-testid="notes-save"
                  disabled={saving.value || draft.value.trim() === ""}
                  onClick$={save}
                  class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-5 py-2 rounded-full text-sm font-medium"
                >
                  {saving.value ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          )}

          {loading.value ? (
            <div class="flex items-center justify-center py-12" data-testid="notes-loading">
              <div class="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : notes.value.length === 0 && !(place.value === "my_notes" && needsSetUp.value) ? (
            <p class="text-sm text-gray-500 py-8 text-center" data-testid="notes-empty">
              {place.value === "board" ? "No notes on the board yet." : "No private notes yet."}
            </p>
          ) : (
            <ul class="flex flex-col gap-3" data-testid="notes-list" data-count={notes.value.length}>
              {notes.value.map((note) => {
                const mine = place.value === "my_notes" || myKeys.value.includes(note.author) || note.author === myKey.value;
                // On the board a note is changed on the device that wrote
                // it; a private note on any of the person's devices.
                const canChange = linked.value && (place.value === "my_notes" || note.author === myKey.value);
                return (
                  <li key={note.id} class="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3" data-testid="notes-row" data-mine={mine ? "1" : "0"}>
                    {editing.value === note.id ? (
                      <>
                        <textarea
                          data-testid="notes-edit-text"
                          rows={3}
                          maxLength={MAX_CHARS[place.value]}
                          value={editText.value}
                          onInput$={(_, el) => (editText.value = el.value)}
                          class="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:border-indigo-500 focus:outline-none"
                        />
                        <div class="mt-2 flex justify-end gap-2">
                          <button type="button" onClick$={() => (editing.value = null)} class="text-sm text-gray-400 hover:text-gray-200 px-3 py-1.5">
                            Cancel
                          </button>
                          <button
                            type="button"
                            data-testid="notes-edit-save"
                            disabled={editText.value.trim() === ""}
                            onClick$={() => saveEdit(note.id)}
                            class="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-full text-sm font-medium"
                          >
                            Save
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p class="text-sm text-gray-100 whitespace-pre-wrap break-words" data-testid="notes-row-text">
                          {note.text}
                        </p>
                        <div class="mt-2 flex items-center justify-between gap-3">
                          <p class="text-xs text-gray-500" data-testid="notes-row-meta">
                            {place.value === "board" && (
                              <span title={note.author}>
                                {mine ? (note.author === myKey.value ? "You" : "You, on another device") : `Someone else (${note.author.slice(0, 9)}...${note.author.slice(-4)})`}
                                {" · "}
                              </span>
                            )}
                            {whenWritten(note.created_at, now.value)}
                            {note.edited_at !== null && " · edited"}
                          </p>
                          {canChange && (
                            <div class="flex gap-3">
                              <button
                                type="button"
                                data-testid="notes-row-edit"
                                onClick$={() => {
                                  editText.value = note.text;
                                  editing.value = note.id;
                                }}
                                class="text-xs text-gray-400 hover:text-gray-200"
                              >
                                Edit
                              </button>
                              <button type="button" data-testid="notes-row-delete" onClick$={() => remove(note.id)} class="text-xs text-gray-400 hover:text-red-300">
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
});
