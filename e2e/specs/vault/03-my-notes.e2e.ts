// My notes, signed in (01): the tab asks to set the private notes up on
// this device; the set-up takes a secret from the Vault test instance,
// joins the person's own network and restarts Holochain once; the tab then
// shows the form, and a note written there is listed. Each tab shows its own
// notes: the private one is not on the board, and a board note is not among
// the private ones. Last, the Identity page says a backup was saved.
// The private note is left in place (04 reads it); the board note is deleted.
import { byId, click, COLD_START_MS, copyProblems, copyProblemsOutside, fill, goto, harnessOp, harnessStatus, inNoteRow, neverShows, noteRow, openNotesTab, shot, timed, waitAppShown, waitNoteGone, waitNoteListed, waitReady, waitSignedIn, whichShows } from "../_helpers";

const problems: string[] = [];
// The list shows people's own words: not the app's.
const noteNotes = async (where: string) => { problems.push(...(await copyProblemsOutside(where, ["notes-row-text"]))); };

const stamp = Date.now().toString(36);
const PRIVATE = `Private note of the UI test ${stamp}`;
const PUBLIC = `Board note of the UI test ${stamp}`;
const TEXT = '[data-testid="notes-text"]';

const notesOf = async (place: "board" | "my_notes"): Promise<any[]> => {
  const r = await harnessOp({ op: "notes", place });
  expect(r.error).toBeNull();
  return r.data;
};

describe("my notes", () => {
  it("the app opens signed in, with the private notes not set up yet", async () => {
    await waitAppShown();
    await waitSignedIn();
    expect((await harnessStatus()).app?.my_notes_ready).toBe(false);
  });

  it("the My notes tab asks to set them up, with no form to write yet", async () => {
    await openNotesTab("mine");
    const state = await whichShows(["notes-set-up", "notes-text", "notes-signed-out", "notes-error"], 60_000, "the My notes tab");
    expect(state).toBe("notes-set-up");
    expect(await (await byId("notes-set-up")).getText()).toContain("Set up your private notes on this device");
    expect(await (await byId("notes-text")).isExisting()).toBe(false);
    expect(await (await byId("notes-restore")).isExisting()).toBe(false);
    expect(await (await byId("notes-error")).isExisting()).toBe(false);
    await shot("my-notes-set-up");
    await noteNotes("my notes, to set up");
  });

  it("setting up restarts Holochain once, and the tab then shows the form", async () => {
    await click("notes-set-up-go");
    // The Vault's secret, the install, then Holochain stops and starts
    // again: the page shows the form only when all of it is done.
    const end = await timed("private notes set up", () => whichShows(["notes-text", "notes-set-up-error"], COLD_START_MS, "the set-up of the private notes", 3_000));
    if (end === "notes-set-up-error") {
      await shot("my-notes-set-up-error");
      throw new Error(`the set-up failed: "${(await (await byId("notes-set-up-error")).getText()).replace(/\s+/g, " ")}"`);
    }
    await waitReady();
    expect((await harnessStatus()).app?.my_notes_ready).toBe(true);
    expect(await (await byId("notes-set-up")).isExisting()).toBe(false);
    // The start screens never replaced the page, and the sign-in held.
    expect(await (await byId("nav-connection-lost")).isExisting()).toBe(false);
    await waitSignedIn(60_000);
  });

  it("a new person's private notes are empty, with nothing to restore", async () => {
    const state = await timed("my notes settled", () => whichShows(["notes-empty", "notes-list", "notes-error"], COLD_START_MS, "the private notes"));
    if (state === "notes-error") {
      throw new Error(`the private notes could not be read: "${(await (await byId("notes-error")).getText()).replace(/\s+/g, " ")}"`);
    }
    expect(state).toBe("notes-empty");
    expect((await (await byId("notes-empty")).getText()).trim()).toBe("No private notes yet.");
    // The Vault's backups are read right after the set-up: they hold no
    // private note of this new identity.
    await neverShows("notes-restore", 20_000, "a restore offer with nothing to restore");
    await shot("my-notes-empty");
    await noteNotes("my notes, empty");
  });

  it("a private note written on the page is listed", async () => {
    expect(await (await byId("notes-save")).isEnabled()).toBe(false);
    await fill(TEXT, PRIVATE);
    await click("notes-save");
    await waitNoteListed(PRIVATE);
    await browser.waitUntil(async () => (await (await byId("notes-text")).getValue()) === "", { timeout: 30_000, timeoutMsg: "the form kept the saved note's text" });
    // Any of the person's devices changes a private note: this one offers to.
    expect(await (await inNoteRow(PRIVATE, "notes-row-edit")).isDisplayed()).toBe(true);
    expect(await (await inNoteRow(PRIVATE, "notes-row-delete")).isDisplayed()).toBe(true);
    // No author line here: every private note is the person's.
    expect((await (await inNoteRow(PRIVATE, "notes-row-meta")).getText()).trim()).not.toMatch(/^You|Someone else/);
    expect((await notesOf("my_notes")).filter((n) => n.text === PRIVATE).length).toBe(1);
    await shot("my-notes-note-written");
    await noteNotes("my notes, a note written");
  });

  it("the board does not show the private note, and shows its own", async () => {
    await openNotesTab("board");
    await fill(TEXT, PUBLIC);
    await click("notes-save");
    // The board's list is on screen once its new note is.
    await waitNoteListed(PUBLIC);
    expect(await (await $(noteRow(PRIVATE))).isExisting()).toBe(false);
    expect((await notesOf("board")).some((n) => n.text === PRIVATE)).toBe(false);
    await shot("my-notes-board-side");
  });

  it("My notes shows the private note, and not the board's", async () => {
    await openNotesTab("mine");
    await waitNoteListed(PRIVATE);
    expect(await (await $(noteRow(PUBLIC))).isExisting()).toBe(false);
    expect(await (await byId("notes-set-up")).isExisting()).toBe(false);
    expect((await notesOf("my_notes")).some((n) => n.text === PUBLIC)).toBe(false);
    await shot("my-notes-private-side");
  });

  it("the board note is deleted again, and the private one stays", async () => {
    await openNotesTab("board");
    const del = await inNoteRow(PUBLIC, "notes-row-delete");
    await del.waitForDisplayed({ timeout: 120_000 });
    await del.click();
    await waitNoteGone(PUBLIC);
    expect((await notesOf("my_notes")).some((n) => n.text === PRIVATE)).toBe(true);
  });

  it("the Identity page says the notes were backed up to the Vault", async () => {
    // Every write asks for a backup half a minute later, and the page reads
    // the last outcome every 15 s. The time it shows has no seconds, so
    // this only shows that a backup was saved since the app opened.
    await goto("nav-settings", "/identity/");
    expect(await whichShows(["identity-linked", "identity-signed-out"], COLD_START_MS, "the Identity page")).toBe("identity-linked");
    const outcome = await byId("identity-backup-outcome");
    await outcome.waitForDisplayed({ timeout: 30_000 });
    let said = "";
    await timed("backup saved", () => browser.waitUntil(async () => {
      said = (await outcome.getText()).trim();
      return said.startsWith("Last backup saved");
    }, { timeout: 180_000, interval: 3_000 }).catch(() => {
      throw new Error(`no backup was saved in 3 minutes; the Identity page says: "${said}"`);
    }));
    await shot("my-notes-backup-saved");
    problems.push(...(await copyProblems("identity, backup saved")));
    await goto("nav-notes", "/");
  });
});

describe("wording", () => {
  it("no screen showed wording the app must never show", async () => {
    if (problems.length) console.log("WORDING PROBLEMS:\n  " + [...new Set(problems)].join("\n  "));
    expect([...new Set(problems)]).toEqual([]);
  });
});
