// Restoring private notes from the Vault backup, signed in with the private
// notes set up (01, 03).
//
// What this device can show about notes it has seen:
//   - while a note is on the device and in the backup, nothing is offered,
//     and a restore of it writes nothing;
//   - a note the person deleted stays deleted: the backup still holds it,
//     and it is neither offered nor written back;
//   - a note this device has never seen is written back as a new record
//     that names the id it had.
//
// The offer itself needs a device that has never seen the notes (a new
// device, or this one with its data gone): that is 06, on an empty profile.
//
// The note, the backup and the delete go through the test door, so no write
// of the page's is waiting to make a newer backup while the page is read.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { byId, copyProblemsOutside, harnessOp, harnessStatus, neverShows, noteRow, openNotesTab, PROFILE, shot, timed, waitAppShown, waitNoteListed, waitSignedIn } from "../_helpers";

const problems: string[] = [];
// The list shows people's own words: not the app's.
const noteNotes = async (where: string) => { problems.push(...(await copyProblemsOutside(where, ["notes-row-text"]))); };

const stamp = Date.now().toString(36);
const LOST = `Note to restore, UI test ${stamp}`;
/** The note's id while it was on the device and in the backup. */
let firstId = "";

const myNotes = async (): Promise<any[]> => {
  const r = await harnessOp({ op: "notes", place: "my_notes" });
  expect(r.error).toBeNull();
  return r.data;
};

describe("restoring private notes from the Vault backup", () => {
  it("the app opens signed in, with the private notes set up", async () => {
    await waitAppShown();
    await waitSignedIn();
    await browser.waitUntil(async () => (await harnessStatus()).app?.my_notes_ready === true, { timeout: 120_000, interval: 3_000, timeoutMsg: "the private notes were not there after a restart of the app" });
  });

  it("a private note is written and the Vault backup holds it", async () => {
    const made = await harnessOp({ op: "create_note", place: "my_notes", text: LOST });
    expect(made.error).toBeNull();
    firstId = made.data;
    expect(typeof firstId).toBe("string");
    const here = await myNotes();
    expect(here.some((n) => n.id === firstId && n.text === LOST)).toBe(true);
    // The backup the page makes, made now.
    const backup = await timed("backup", () => harnessOp({ op: "backup" }));
    expect(backup.error).toBeNull();
    expect(backup.data?.saved).toBe(true);
    expect(backup.data?.summary?.my_notes).toBe(here.length);
  });

  it("with the note on the device, My notes offers no restore", async () => {
    await openNotesTab("mine");
    await waitNoteListed(LOST);
    // The backups are read a moment after the list.
    await neverShows("notes-restore", 20_000, "a restore offer while every backed-up note is on the device");
    expect(await (await byId("notes-restored")).isExisting()).toBe(false);
    await shot("restore-nothing-to-offer");
    await noteNotes("my notes, nothing to restore");
  });

  it("restoring a note that is on the device writes nothing", async () => {
    const before = await myNotes();
    const r = await harnessOp({ op: "restore_my_notes", notes: [{ id: firstId, text: LOST }] });
    expect(r.error).toBeNull();
    expect(r.data).toBe(0);
    expect((await myNotes()).length).toBe(before.length);
  });

  it("a note the person deleted is not offered back, though the backup holds it", async () => {
    const gone = await harnessOp({ op: "delete_note", place: "my_notes", id: firstId });
    expect(gone.error).toBeNull();
    await browser.waitUntil(async () => !(await myNotes()).some((n) => n.text === LOST), { timeout: 120_000, interval: 3_000, timeoutMsg: "the app still lists the deleted note" });
    const offered = await harnessOp({ op: "restorable_notes", notes: [{ id: firstId, text: LOST }] });
    expect(offered.error).toBeNull();
    expect(offered.data).toEqual([]);
    // The page reads the backups when the tab is opened: open it again.
    await openNotesTab("board");
    await openNotesTab("mine");
    await neverShows("notes-restore", 20_000, "an offer to restore a note the person deleted");
    expect(await (await $(noteRow(LOST))).isExisting()).toBe(false);
    const r = await harnessOp({ op: "restore_my_notes", notes: [{ id: firstId, text: LOST }] });
    expect(r.error).toBeNull();
    expect(r.data).toBe(0);
    await shot("restore-deleted-stays-deleted");
    await noteNotes("my notes, a deleted note not offered");
  });

  it("a note this device has never seen is written back, once, and names the id it had", async () => {
    // An id no private note here has, and a real one: a board note's. The
    // two places are separate networks, so the private notes never saw it.
    const other = await harnessOp({ op: "create_note", place: "board", text: `Board note for an id, UI test ${stamp}` });
    expect(other.error).toBeNull();
    const UNSEEN: string = other.data;
    expect((await harnessOp({ op: "delete_note", place: "board", id: UNSEEN })).error).toBeNull();
    const text = `Note from another device, UI test ${stamp}`;
    const offered = await harnessOp({ op: "restorable_notes", notes: [{ id: UNSEEN, text }] });
    expect(offered.error).toBeNull();
    expect(offered.data?.length).toBe(1);
    const r = await harnessOp({ op: "restore_my_notes", notes: [{ id: UNSEEN, text }] });
    expect(r.error).toBeNull();
    expect(r.data).toBe(1);
    const back = (await myNotes()).filter((n) => n.text === text);
    expect(back.length).toBe(1);
    expect(back[0].restored_from).toBe(UNSEEN);
    const again = await harnessOp({ op: "restore_my_notes", notes: [{ id: UNSEEN, text }] });
    expect(again.data).toBe(0);
    await openNotesTab("board");
    await openNotesTab("mine");
    await waitNoteListed(text);
    await neverShows("notes-restore", 20_000, "an offer of a note that was restored");
    await noteNotes("my notes, restored");
  });

  it("the Vault backup is made again, and what it holds is written down for the new device (06)", async () => {
    const here = await myNotes();
    expect(here.length).toBeGreaterThan(0);
    const backup = await timed("backup", () => harnessOp({ op: "backup" }));
    expect(backup.error).toBeNull();
    expect(backup.data?.saved).toBe(true);
    expect(backup.data?.summary?.my_notes).toBe(here.length);
    writeFileSync(resolve(PROFILE, "backed-up-notes.json"), JSON.stringify(here.map((n) => n.text)));
  });
});

describe("wording", () => {
  it("no screen showed wording the app must never show", async () => {
    if (problems.length) console.log("WORDING PROBLEMS:\n  " + [...new Set(problems)].join("\n  "));
    expect([...new Set(problems)]).toEqual([]);
  });
});
