// Disconnect, last in the suite (it ends the sign-in the earlier specs
// use): the person asks on the Identity page and confirms; the link is
// removed here and revoked on the network; the Vault is told and its answer
// waited for; the page says what the Vault did. With the test Vault running
// and holding this install's link, that is "Your Vault no longer lists" the
// app. The header then offers the sign-in again, and the Notes page reads
// without offering to write: the board, and the private notes too.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { byId, click, COLD_START_MS, copyProblems, copyProblemsOutside, goto, harnessOp, harnessStatus, openNotesTab, shot, timed, waitAppShown, waitSignedIn, whichShows, PROFILE } from "../_helpers";

const problems: string[] = [];
const APP_NAME = "Holochain Desktop Starter";

describe("disconnecting the Flowsta account", () => {
  it("is offered on the Identity page of a signed-in app", async () => {
    await waitAppShown();
    await waitSignedIn();
    await goto("nav-settings", "/identity/");
    const state = await timed("identity page settled", () => whichShows(["identity-linked", "identity-signed-out"], COLD_START_MS, "the Identity page"));
    expect(state).toBe("identity-linked");
    expect((await harnessStatus()).identity_link).toBeTruthy();
    expect(await (await byId("identity-disconnect")).isDisplayed()).toBe(true);
  });

  it("asks once more, and Cancel leaves the sign-in as it was", async () => {
    await click("identity-disconnect");
    const confirm = await byId("identity-disconnect-confirm");
    await confirm.waitForDisplayed({ timeout: 10_000 });
    await shot("disconnect-confirm");
    problems.push(...(await copyProblems("disconnect, the question")));
    const cancel = await $("button=Cancel");
    await cancel.click();
    await (await byId("identity-disconnect")).waitForDisplayed({ timeout: 10_000 });
    expect((await harnessStatus()).identity_link).toBeTruthy();
    expect(await (await byId("identity-linked")).isDisplayed()).toBe(true);
  });

  it("disconnects, and says the Vault no longer lists the app", async () => {
    await click("identity-disconnect");
    await click("identity-disconnect-confirm");
    // The network write, then the Vault's answer (the SDK waits up to 10 s).
    const state = await timed("signed out", () => whichShows(["identity-signed-out", "identity-error"], 180_000, "the Identity page after Disconnect"));
    if (state === "identity-error") console.log(`e2e: disconnect failed with: ${await (await byId("identity-error")).getText()}`);
    expect(state).toBe("identity-signed-out");
    const notice = (await (await byId("identity-success")).getText()).trim();
    console.log(`e2e: after Disconnect the page says: ${notice}`);
    await shot("disconnected");
    problems.push(...(await copyProblems("disconnected")));
    expect(notice).toBe(`Flowsta account disconnected. Your Vault no longer lists ${APP_NAME}.`);
  });

  it("is signed out here: no link kept, and the Identity page offers the sign-in", async () => {
    await browser.waitUntil(async () => !(await harnessStatus()).identity_link, { timeout: 30_000, timeoutMsg: "the install still holds its identity link" });
    await (await byId("identity-signin")).waitForEnabled({ timeout: 60_000 });
    expect(await (await byId("identity-linked")).isExisting()).toBe(false);
  });

  it("the header offers the sign-in again and shows no profile", async () => {
    await (await byId("nav-signin")).waitForDisplayed({ timeout: 60_000 });
    expect(await (await byId("nav-profile")).isExisting()).toBe(false);
    expect(await (await byId("nav-profile-name")).isExisting()).toBe(false);
    expect(await (await byId("nav-mismatch-banner")).isExisting()).toBe(false);
    expect(await (await byId("nav-reconnect-banner")).isExisting()).toBe(false);
    await shot("disconnected-header");
  });

  it("the Notes page asks to sign in, and the board is still read", async () => {
    await goto("nav-notes", "/");
    const notice = await byId("notes-signed-out");
    await notice.waitForDisplayed({ timeout: 60_000 });
    expect(await notice.getText()).toContain("Sign in with Flowsta to write on the board.");
    const state = await timed("the board settled", () => whichShows(["notes-list", "notes-empty", "notes-error"], COLD_START_MS, "the board"));
    if (state === "notes-error") {
      throw new Error(`the board could not be read: "${(await (await byId("notes-error")).getText()).replace(/\s+/g, " ")}"`);
    }
    // Read-only: no form, and no note offers Edit or Delete.
    expect(await (await byId("notes-text")).isExisting()).toBe(false);
    expect(await (await byId("notes-save")).isExisting()).toBe(false);
    expect(await (await byId("notes-row-edit")).isExisting()).toBe(false);
    expect(await (await byId("notes-row-delete")).isExisting()).toBe(false);
    // The app itself still reads the board.
    const read = await harnessOp({ op: "notes", place: "board" });
    expect(read.error).toBeNull();
    expect(Array.isArray(read.data)).toBe(true);
    await shot(`disconnected-board-${state}`);
    problems.push(...(await copyProblemsOutside(`the board, disconnected (${state})`, ["notes-row-text"])));
  });

  it("My notes asks to sign in too, and offers nothing to write, set up or restore", async () => {
    await openNotesTab("mine");
    await browser.waitUntil(async () => (await (await byId("notes-signed-out")).getText()).includes("Sign in with Flowsta to keep private notes."), { timeout: 15_000, timeoutMsg: "the private tab never asked to sign in" });
    const state = await timed("my notes settled", () => whichShows(["notes-list", "notes-empty", "notes-error"], COLD_START_MS, "the private notes"));
    expect(state).not.toBe("notes-error");
    expect(await (await byId("notes-text")).isExisting()).toBe(false);
    expect(await (await byId("notes-set-up")).isExisting()).toBe(false);
    expect(await (await byId("notes-restore")).isExisting()).toBe(false);
    expect(await (await byId("notes-row-edit")).isExisting()).toBe(false);
    await shot("disconnected-private");
    problems.push(...(await copyProblemsOutside("my notes, disconnected", ["notes-row-text"])));
    await openNotesTab("board");
  });

  it("a write is refused by the app itself, whatever the page shows", async () => {
    const r = await harnessOp({ op: "create_note", place: "board", text: "written after the disconnect" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Sign in with Flowsta first");
  });

  it("the next start of the app is a new device (06)", () => {
    writeFileSync(resolve(PROFILE, "next-is-a-new-device"), "");
  });

  it("no screen showed wording the app must never show", () => {
    if (problems.length) console.log("WORDING PROBLEMS:\n  " + [...new Set(problems)].join("\n  "));
    expect([...new Set(problems)]).toEqual([]);
  });
});
