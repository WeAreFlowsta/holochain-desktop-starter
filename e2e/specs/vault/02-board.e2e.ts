// The board, signed in (01): a note written on the page is listed as the
// person's own, with Edit and Delete; its text is changed; it is deleted.
// A note with nothing in it cannot be saved, on the page or past it.
// The board is left as it was found: the one note written here is deleted.
import { byId, click, copyProblemsOutside, fill, harnessOp, harnessStatus, inNoteRow, shot, waitAppShown, waitNoteGone, waitNoteListed, waitSignedIn } from "../_helpers";

const problems: string[] = [];
// The list shows people's own words: not the app's.
const noteNotes = async (where: string) => { problems.push(...(await copyProblemsOutside(where, ["notes-row-text"]))); };

const stamp = Date.now().toString(36);
const WRITTEN = `Written by the UI test ${stamp}`;
const CHANGED = `Changed by the UI test ${stamp}`;
const TEXT = '[data-testid="notes-text"]';
const EDIT_TEXT = '[data-testid="notes-edit-text"]';

const boardNotes = async (): Promise<any[]> => {
  const r = await harnessOp({ op: "notes", place: "board" });
  expect(r.error).toBeNull();
  return r.data;
};

describe("the board, signed in", () => {
  it("the app opens signed in, on the board with the form to write", async () => {
    await waitAppShown();
    await waitSignedIn();
    await (await byId("notes-text")).waitForDisplayed({ timeout: 60_000 });
    expect(await (await byId("notes-about")).getText()).toContain("Everyone using this app can read the board");
  });

  it("an empty note cannot be saved", async () => {
    expect(await (await byId("notes-save")).isEnabled()).toBe(false);
    // Spaces alone are nothing to save either.
    await fill(TEXT, "   ");
    expect(await (await byId("notes-save")).isEnabled()).toBe(false);
    await fill(TEXT, "");
    // Past the page, the board's own rules refuse it.
    const r = await harnessOp({ op: "create_note", place: "board", text: "   " });
    expect(r.ok).toBe(false);
    console.log(`e2e: an empty note is refused with: ${r.error}`);
  });

  it("a note written on the page is listed as the person's own", async () => {
    await fill(TEXT, WRITTEN);
    await click("notes-save");
    await waitNoteListed(WRITTEN);
    // The form is empty again for the next note.
    await browser.waitUntil(async () => (await (await byId("notes-text")).getValue()) === "", { timeout: 30_000, timeoutMsg: "the form kept the saved note's text" });
    // "You", once the page has read this device's key (its ten-second read).
    const meta = await inNoteRow(WRITTEN, "notes-row-meta");
    await browser.waitUntil(async () => /^You\b/.test((await meta.getText()).trim()), { timeout: 60_000, timeoutMsg: "the note was never shown as the person's own" });
    expect(await meta.getText()).not.toContain("another device");
    expect(await (await inNoteRow(WRITTEN, "notes-row-edit")).isDisplayed()).toBe(true);
    expect(await (await inNoteRow(WRITTEN, "notes-row-delete")).isDisplayed()).toBe(true);
    // The app holds it under this device's key.
    const mine = (await boardNotes()).find((n) => n.text === WRITTEN);
    expect(mine).toBeTruthy();
    expect(mine.author).toBe((await harnessStatus()).app?.agent_pub_key);
    expect(mine.edited_at).toBeNull();
    await shot("board-note-written");
    await noteNotes("the board, a note written");
  });

  it("the note is edited, and says so", async () => {
    const edit = await inNoteRow(WRITTEN, "notes-row-edit");
    await edit.waitForDisplayed({ timeout: 30_000 });
    await edit.click();
    const box = await byId("notes-edit-text");
    await box.waitForDisplayed({ timeout: 30_000 });
    expect(await box.getValue()).toBe(WRITTEN);
    // An edit down to nothing cannot be saved.
    await fill(EDIT_TEXT, "  ");
    await (await byId("notes-edit-save")).waitForEnabled({ timeout: 30_000, reverse: true, timeoutMsg: "an empty edit could be saved" });
    await shot("board-note-editing");
    await fill(EDIT_TEXT, CHANGED);
    await click("notes-edit-save");
    await waitNoteListed(CHANGED);
    await waitNoteGone(WRITTEN);
    const meta = await inNoteRow(CHANGED, "notes-row-meta");
    await browser.waitUntil(async () => (await meta.getText()).includes("edited"), { timeout: 60_000, timeoutMsg: "the note never said it was edited" });
    const notes = await boardNotes();
    expect(notes.some((n) => n.text === WRITTEN)).toBe(false);
    expect(notes.find((n) => n.text === CHANGED)?.edited_at).not.toBeNull();
    await shot("board-note-edited");
    await noteNotes("the board, a note edited");
  });

  it("the note is deleted", async () => {
    const del = await inNoteRow(CHANGED, "notes-row-delete");
    await del.waitForDisplayed({ timeout: 30_000 });
    await del.click();
    await waitNoteGone(CHANGED);
    expect(await (await byId("notes-error")).isExisting()).toBe(false);
    await browser.waitUntil(async () => !(await boardNotes()).some((n) => n.text === CHANGED), { timeout: 120_000, interval: 3_000, timeoutMsg: "the app still lists the deleted note" });
    await shot("board-note-deleted");
    await noteNotes("the board, a note deleted");
  });
});

describe("wording", () => {
  it("no screen showed wording the app must never show", async () => {
    if (problems.length) console.log("WORDING PROBLEMS:\n  " + [...new Set(problems)].join("\n  "));
    expect([...new Set(problems)]).toEqual([]);
  });
});
