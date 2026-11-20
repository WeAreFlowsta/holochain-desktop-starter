import { test } from "node:test";
import assert from "node:assert/strict";
import type { Note } from "./holochain";
import { countOfNotes, missingFromBackups, notesIn } from "./restore";

const here = (id: string, restored_from: string | null = null): Note => ({ id, author: "uhCAkme", text: `text of ${id}`, created_at: 1, edited_at: null, restored_from });
const backup = (...notes: { id: string; text: string; restored_from?: string | null }[]) => ({ _summary: { totalRecords: notes.length }, board: [], my_notes: notes });

test("a new device is offered every note in the backup", () => {
  const missing = missingFromBackups([backup({ id: "a", text: "one" }, { id: "b", text: "two" })], []);
  assert.deepEqual(missing.map((n) => n.id), ["a", "b"]);
});

test("a note that is here is not offered, nor one that was restored before", () => {
  const missing = missingFromBackups([backup({ id: "a", text: "one" }, { id: "b", text: "two" }, { id: "c", text: "three" })], [here("a"), here("x", "b")]);
  assert.deepEqual(missing.map((n) => n.id), ["c"]);
});

test("a restored copy in a backup is the note it was restored from", () => {
  // The laptop restored note "a" as "x" and backed that up. On a device
  // that holds "a", nothing is missing; on an empty one it comes back once.
  const laptop = backup({ id: "x", text: "one", restored_from: "a" });
  assert.deepEqual(missingFromBackups([laptop], [here("a")]), []);
  const old = backup({ id: "a", text: "one, before the edit" });
  assert.deepEqual(missingFromBackups([laptop, old], []).map((n) => n.text), ["one"], "once, with the newest backup's text");
});

test("a backup with no private notes, or of another shape, offers nothing", () => {
  assert.deepEqual(notesIn(null), []);
  assert.deepEqual(notesIn({ board: [{ id: "a", text: "on the board" }] }), []);
  assert.deepEqual(notesIn({ my_notes: [{ id: 1, text: "no id" }, { text: "nothing" }, null] }), []);
  assert.deepEqual(missingFromBackups([], [here("a")]), []);
});

test("the offer counts notes the way a person does", () => {
  assert.equal(countOfNotes(1), "1 note");
  assert.equal(countOfNotes(3), "3 notes");
});
