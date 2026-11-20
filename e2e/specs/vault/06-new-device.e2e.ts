// The same person on a new device: an empty data folder against the same
// Vault (05 left the marker the launcher reads). The first device is not
// running, so nothing arrives from it: what the person had is in the Vault
// backup alone.
//
// They sign in and set the private notes up, as on the first device. My
// notes then says how many notes the backup holds that are not here, and
// offers them. One press writes them back; the page says how many, the
// offer goes, and a second look offers nothing.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { byId, click, COLD_START_MS, copyProblemsOutside, goto, harnessOp, harnessStatus, neverShows, openNotesTab, PROFILE, shot, timed, waitAppShown, waitNoteListed, waitReady, waitSignedIn, whichShows } from "../_helpers";

const problems: string[] = [];
// The list shows people's own words: not the app's.
const noteNotes = async (where: string) => { problems.push(...(await copyProblemsOutside(where, ["notes-row-text"]))); };

/** What the first device's last backup held (04 wrote it down). */
const BACKED_UP: string[] = existsSync(resolve(PROFILE, "backed-up-notes.json")) ? JSON.parse(readFileSync(resolve(PROFILE, "backed-up-notes.json"), "utf8")) : [];
const count = (n: number) => `${n} note${n === 1 ? "" : "s"}`;

const myNotes = async (): Promise<any[]> => {
  const r = await harnessOp({ op: "notes", place: "my_notes" });
  expect(r.error).toBeNull();
  return r.data;
};

describe("the same person on a new device", () => {
  it("the first device left a backup with notes in it", () => {
    expect(BACKED_UP.length).toBeGreaterThan(0);
  });

  it("the app opens as new: not signed in, nothing set up", async () => {
    await waitAppShown();
    await (await byId("nav-signin")).waitForDisplayed({ timeout: 60_000 });
    const status = await harnessStatus();
    expect(status.identity_link ?? null).toBeNull();
    expect(status.app?.my_notes_ready).toBe(false);
  });

  it("the person signs in with the same Vault", async () => {
    await goto("nav-signin", "/identity/");
    const end = await timed("sign-in", () => whichShows(["identity-linked", "identity-error"], COLD_START_MS, "the sign-in"));
    if (end === "identity-error") {
      await shot("new-device-signin-error");
      throw new Error(`the sign-in failed: "${(await (await byId("identity-error")).getText()).replace(/\s+/g, " ")}"`);
    }
    await waitSignedIn(60_000);
  });

  it("My notes asks to be set up, and offers no restore before that", async () => {
    await goto("nav-notes", "/");
    await openNotesTab("mine");
    const state = await whichShows(["notes-set-up", "notes-text", "notes-signed-out", "notes-error"], 60_000, "the My notes tab");
    expect(state).toBe("notes-set-up");
    expect(await (await byId("notes-restore")).isExisting()).toBe(false);
    await shot("new-device-set-up");
    await noteNotes("my notes on a new device, to set up");
  });

  it("after the set-up, the page offers the notes in the Vault backup", async () => {
    await click("notes-set-up-go");
    const end = await timed("private notes set up", () => whichShows(["notes-text", "notes-set-up-error"], COLD_START_MS, "the set-up of the private notes", 3_000));
    if (end === "notes-set-up-error") {
      await shot("new-device-set-up-error");
      throw new Error(`the set-up failed: "${(await (await byId("notes-set-up-error")).getText()).replace(/\s+/g, " ")}"`);
    }
    await waitReady();
    // Nothing of the first device has arrived: it is not running.
    expect((await myNotes()).length).toBe(0);
    const offer = await byId("notes-restore");
    await timed("restore offer", () => offer.waitForDisplayed({ timeout: 120_000, timeoutMsg: "the page never offered the notes in the Vault backup" }));
    const said = (await offer.getText()).replace(/\s+/g, " ");
    expect(said).toContain(`Your Vault backup has ${count(BACKED_UP.length)} that ${BACKED_UP.length === 1 ? "is" : "are"} not on this device`);
    expect((await (await byId("notes-restore-go")).getText()).trim()).toBe(`Restore ${count(BACKED_UP.length)}`);
    expect(await (await byId("notes-restore-error")).isExisting()).toBe(false);
    await shot("new-device-restore-offer");
    await noteNotes("my notes on a new device, the offer");
  });

  it("one press writes them back, and the page says how many", async () => {
    await click("notes-restore-go");
    const done = await byId("notes-restored");
    await timed("restore", () => done.waitForDisplayed({ timeout: 180_000, timeoutMsg: "the page never said the notes were restored" }));
    expect((await done.getText()).replace(/\s+/g, " ").trim()).toBe(`${count(BACKED_UP.length)} restored from your Vault backup.`);
    expect(await (await byId("notes-restore")).isExisting()).toBe(false);
    for (const text of BACKED_UP) await waitNoteListed(text);
    const here = await myNotes();
    expect(here.map((n) => n.text).sort()).toEqual([...BACKED_UP].sort());
    // Each is a new record that names the note it was.
    expect(here.every((n) => typeof n.restored_from === "string" && n.restored_from.length > 0)).toBe(true);
    await shot("new-device-restored");
    await noteNotes("my notes on a new device, restored");
  });

  it("a second look offers nothing more", async () => {
    await openNotesTab("board");
    await openNotesTab("mine");
    for (const text of BACKED_UP) await waitNoteListed(text);
    await neverShows("notes-restore", 20_000, "an offer of notes that were just restored");
    expect((await myNotes()).length).toBe(BACKED_UP.length);
    await noteNotes("my notes on a new device, a second look");
  });
});

describe("wording", () => {
  it("no screen showed wording the app must never show", async () => {
    if (problems.length) console.log("WORDING PROBLEMS:\n  " + [...new Set(problems)].join("\n  "));
    expect([...new Set(problems)]).toEqual([]);
  });
});
