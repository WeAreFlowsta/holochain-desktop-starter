// Signing in: the app opens signed out; the header's sign-in button opens
// the Identity page and starts the sign-in with the Vault test instance (the
// test build pins the app's Vault calls to it, and it approves on its own).
// The Identity page then says signed in and names the identity, the header
// shows the name, the app's own record of the link is set, and the Notes
// page shows the form to write.
import { byId, COLD_START_MS, copyProblems, copyProblemsOutside, E2E_NAME, goto, harnessOp, harnessStatus, shot, timed, waitAppShown, waitSignedIn, whichShows } from "../_helpers";

const problems: string[] = [];
const note = async (where: string) => { problems.push(...(await copyProblems(where))); };

describe("signing in with Flowsta", () => {
  it("the app opens, not signed in yet", async () => {
    await waitAppShown();
    await (await byId("nav-signin")).waitForDisplayed({ timeout: 60_000 });
    expect(await (await byId("nav-profile")).isExisting()).toBe(false);
    expect((await harnessStatus()).identity_link ?? null).toBeNull();
    // The Notes page reads, and asks for the sign-in before writing.
    await (await byId("notes-signed-out")).waitForDisplayed({ timeout: 60_000 });
    expect(await (await byId("notes-text")).isExisting()).toBe(false);
    await shot("signin-signed-out");
  });

  it("the header's sign-in button opens the Identity page and connects to the Vault", async () => {
    // The button asks the Identity page to start the sign-in at once.
    await goto("nav-signin", "/identity/");
    const first = await timed("identity page settled", () => whichShows(["identity-signed-out", "identity-linked", "identity-error"], COLD_START_MS, "the Identity page"));
    // While the Vault answers, the page says what is happening.
    if (first === "identity-signed-out" && (await (await byId("identity-connecting")).isDisplayed().catch(() => false))) {
      await shot("signin-connecting");
      await note("identity, connecting");
    }
    // A first sign-in writes the link to the network: it can take minutes.
    const end = await timed("sign-in", () => whichShows(["identity-linked", "identity-error"], 300_000, "the sign-in"));
    if (end === "identity-error") {
      await shot("signin-error");
      throw new Error(`the sign-in failed: "${(await (await byId("identity-error")).getText()).replace(/\s+/g, " ")}"`);
    }
    expect((await (await byId("identity-success")).getText()).trim()).toBe("Signed in.");
  });

  it("the Identity page says signed in and names the identity", async () => {
    const name = await byId("identity-display-name");
    await browser.waitUntil(async () => (await name.getText()).trim() === E2E_NAME, {
      timeout: 60_000, timeoutMsg: `the Identity page never showed "${E2E_NAME}"`,
    });
    expect(await (await byId("identity-linked")).getText()).toContain("Signed in with Flowsta");
    expect(await (await byId("identity-disconnect")).isDisplayed()).toBe(true);
    expect(await (await byId("identity-signed-out")).isExisting()).toBe(false);
    await shot("signin-identity-linked");
    await note("identity, signed in");
  });

  it("the header shows the name and no longer offers to sign in", async () => {
    await waitSignedIn(60_000);
    expect(await (await byId("nav-signin")).isExisting()).toBe(false);
    expect(await (await byId("nav-mismatch-banner")).isExisting()).toBe(false);
    await shot("signin-header");
  });

  it("the app's own record of the link is set", async () => {
    const link = (await harnessStatus()).identity_link;
    expect(link).toBeTruthy();
    expect(typeof link.vault_agent_pub_key).toBe("string");
    expect(link.vault_agent_pub_key.length).toBeGreaterThan(0);
    const identity = await harnessOp({ op: "identity" });
    expect(identity.error).toBeNull();
    expect(identity.data?.vault_agent_pub_key).toBe(link.vault_agent_pub_key);
  });

  it("the Notes page shows the form to write, and no longer asks to sign in", async () => {
    await goto("nav-notes", "/");
    await (await byId("notes-text")).waitForDisplayed({ timeout: 60_000 });
    expect(await (await byId("notes-signed-out")).isExisting()).toBe(false);
    // Nothing typed yet: nothing to save.
    expect(await (await byId("notes-save")).isEnabled()).toBe(false);
    await shot("signin-notes-form");
    // The list shows people's own words: not the app's.
    problems.push(...(await copyProblemsOutside("the board, signed in", ["notes-row-text"])));
  });
});

describe("wording", () => {
  it("no screen showed wording the app must never show", async () => {
    if (problems.length) console.log("WORDING PROBLEMS:\n  " + [...new Set(problems)].join("\n  "));
    expect([...new Set(problems)]).toEqual([]);
  });
});
