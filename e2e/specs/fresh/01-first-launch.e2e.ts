// A person's first launch, signed out, with no Vault on the computer: the
// app starts Holochain without an error screen, the board settles
// on its notes or says there are none yet, writing asks for the sign-in,
// and the screens a signed-out person can reach read right.
import { byId, click, COLD_START_MS, copyProblems, copyProblemsOutside, goto, harnessOp, harnessStatus, shot, timed, waitReady, whichShows } from "../_helpers";

const problems: string[] = [];
const note = async (where: string) => { problems.push(...(await copyProblems(where))); };
// The list shows people's own words: not the app's.
const noteNotes = async (where: string) => { problems.push(...(await copyProblemsOutside(where, ["notes-row-text"]))); };
const NOTES_STATES = ["notes-list", "notes-empty", "notes-error"];

describe("the first launch", () => {
  it("the window opens and the app gets ready without an error screen", async () => {
    const first = await whichShows(["nav-connecting", "nav-starting", "nav-notes", "nav-connection-lost"], 120_000, "the first paint");
    await shot("launch-first-paint");
    await note(`first paint (${first})`);
    const seen = await timed("ready", () => whichShows(["nav-notes", "nav-connection-lost"], COLD_START_MS, "the app getting ready", 3000));
    if (seen === "nav-connection-lost") {
      await shot("launch-connection-lost");
      throw new Error(`the app showed its error screen: "${(await (await byId("nav-connection-lost")).getText()).replace(/\s+/g, " ")}"`);
    }
    await waitReady(60_000);
    const status = await harnessStatus();
    expect(status.app?.ready).toBe(true);
    expect(typeof status.app?.agent_pub_key).toBe("string");
    expect(status.app?.my_notes_ready).toBe(false);
    expect(status.identity_link ?? null).toBeNull();
    await shot("launch-ready");
  });

  it("the board shows its notes or says there are none yet, with no form to write", async () => {
    const state = await timed("the board settled", () => whichShows(NOTES_STATES, COLD_START_MS, "the Notes page"));
    await shot(`launch-${state}`);
    if (state === "notes-error") {
      throw new Error(`the board could not be read: "${(await (await byId("notes-error")).getText()).replace(/\s+/g, " ")}"`);
    }
    expect(await (await byId("notes-text")).isExisting()).toBe(false);
    expect(await (await byId("notes-signed-out")).getText()).toContain("Sign in with Flowsta to write on the board.");
    // One way to sign in on the screen: the header's.
    expect(await (await byId("notes-signin")).isExisting()).toBe(false);
    expect(await (await byId("nav-signin")).isDisplayed()).toBe(true);
    await noteNotes(`the board, signed out (${state})`);
  });

  it("the private tab asks to sign in too, and offers nothing to set up", async () => {
    await click("notes-tab-mine");
    await browser.waitUntil(async () => (await (await byId("notes-signed-out")).getText()).includes("private notes"), { timeout: 15_000, timeoutMsg: "the private tab never asked to sign in" });
    expect(await (await byId("notes-set-up")).isExisting()).toBe(false);
    expect(await (await byId("notes-text")).isExisting()).toBe(false);
    expect(await (await byId("notes-error")).isExisting()).toBe(false);
    await shot("launch-private-signed-out");
    await noteNotes("my notes, signed out");
    await click("notes-tab-board");
  });

  it("the header offers sign-in and shows no profile or banner", async () => {
    await (await byId("nav-signin")).waitForDisplayed({ timeout: 30_000 });
    expect(await (await byId("nav-profile")).isExisting()).toBe(false);
    expect(await (await byId("nav-mismatch-banner")).isExisting()).toBe(false);
    expect(await (await byId("nav-link-banner")).isExisting()).toBe(false);
  });

  it("a write without a sign-in is refused by the app itself, whatever the page shows", async () => {
    const r = await harnessOp({ op: "create_note", place: "board", text: "written with no sign-in" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Sign in with Flowsta first");
  });

  it("the Identity page offers to sign in with Flowsta", async () => {
    await goto("nav-settings", "/identity/");
    const state = await timed("identity page settled", () => whichShows(["identity-signed-out", "identity-linked"], COLD_START_MS, "the Identity page"));
    expect(state).toBe("identity-signed-out");
    await (await byId("identity-signin")).waitForEnabled({ timeout: 60_000 });
    await shot("launch-identity");
    await note("identity, signed out");
  });

  it("Settings > Updates shows the automatic-updates switch", async () => {
    await click("settings-tab-updates");
    await (await byId("updates-card")).waitForDisplayed({ timeout: 30_000 });
    await shot("launch-updates");
    await note("updates");
    await goto("nav-notes", "/");
  });
});

describe("wording", () => {
  it("no signed-out screen showed wording the app must never show", async () => {
    if (problems.length) console.log("WORDING PROBLEMS:\n  " + [...new Set(problems)].join("\n  "));
    expect([...new Set(problems)]).toEqual([]);
  });
});
