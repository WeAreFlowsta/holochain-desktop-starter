// Shared helpers for the UI specs.
import { senseProblems, type Shown } from "../../src/lib/sense";
import { resolve } from "node:path";
import { SHOTS } from "../wdio.conf";

let step = 0;
/** A numbered picture of the window as it is now. */
export const shot = (name: string) => browser.saveScreenshot(resolve(SHOTS, `${String(++step).padStart(2, "0")}-${name}.png`));

export const byId = (id: string) => $(`[data-testid="${id}"]`);

/** Type into an input the way a person's typing reaches the page: set the
 *  value and send the input event the front end listens for. */
export async function fill(selector: string, text: string) {
  const el = await $(selector);
  await el.waitForDisplayed({ timeout: 30_000 });
  await browser.execute((sel: string, t: string) => {
    const input = document.querySelector(sel) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    input.focus();
    setter ? setter.call(input, t) : (input.value = t);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, text);
}

export async function click(id: string, timeout = 30_000) {
  const el = await byId(id);
  await el.waitForDisplayed({ timeout });
  await el.waitForEnabled({ timeout });
  await el.click();
}

/** Everything a person can read in the window right now. */
export const visibleText = () => browser.execute(() => document.body.innerText);

/** Wording the app must never show (the list grows with what testing finds). */
const BANNED: [RegExp, string][] = [
  [/—/, "has an em dash"],
  [/\b[a-z]+(?:_[a-z]+){1,}\b(?: \[\d{3}\])?/, "shows a raw code"],
  [/\[\d{3}\]/, "shows an HTTP status"],
  [/undefined|NaN|\[object Object\]/, "shows a programming leftover"],
];

export function copyProblemsIn(text: string, where: string): string[] {
  return BANNED.filter(([re]) => re.test(text)).map(([re, why]) => `${where} ${why}: "${text.match(re)?.[0]}"`);
}

export async function copyProblems(where: string): Promise<string[]> {
  return copyProblemsIn(await visibleText(), where);
}

/** A first start installs the board and restarts the conductor once; a
 *  fresh conductor's first network reads can take minutes. */
export const COLD_START_MS = 10 * 60_000;
export async function timed<T>(what: string, run: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await run();
  console.log(`[timed] ${what}: ${Math.round((Date.now() - t0) / 1000)}s`);
  return out;
}

/** The test instance's test door (launch-app.sh's STARTER_HARNESS_PORT):
 *  status and the operations a test uses, for set-up and checks. */
export const HARNESS = `http://127.0.0.1:${process.env.STARTER_E2E_HARNESS_PORT || 28911}`;
export async function harnessStatus(): Promise<any> {
  const r = await fetch(`${HARNESS}/dev/status`, { signal: AbortSignal.timeout(10_000) });
  return r.json();
}
export async function harnessOp(body: Record<string, unknown>, secs = 180): Promise<{ ok: boolean; data: any; error: string | null }> {
  const r = await fetch(`${HARNESS}/dev/op`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(secs * 1000),
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, data, error: r.ok ? null : data?.error || `HTTP ${r.status}` };
}
/** Until the instance's conductor is ready (after the first start's one
 *  restart). */
export async function waitReady(timeout = COLD_START_MS) {
  await browser.waitUntil(async () => {
    try { return (await harnessStatus()).app?.ready === true; } catch { return false; }
  }, { timeout, interval: 3000, timeoutMsg: "the app never became ready" });
}

/** The display name wdio.conf.ts gives the Vault test instance's identity. */
export const E2E_NAME = "Starter E2E";

/** The first of these test ids on screen, waiting until one is. */
export async function whichShows(ids: string[], timeout: number, what: string, interval = 1000): Promise<string> {
  let seen = "";
  await browser.waitUntil(async () => {
    seen = await browser.execute((list: string[]) => list.find((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return !!el && el.getClientRects().length > 0;
    }) ?? "", ids);
    return seen !== "";
  }, { timeout, interval, timeoutMsg: `${what}: none of ${ids.join(", ")} showed in ${Math.round(timeout / 1000)} s` });
  return seen;
}

/** A spec's first step (the service starts a fresh app per spec file): the
 *  window shows the app's header, never the error screen, and the
 *  harness agrees the app is ready. */
export async function waitAppShown(timeout = COLD_START_MS) {
  const seen = await timed("app shown", () => whichShows(["nav-notes", "nav-connection-lost"], timeout, "the app getting ready", 3000));
  if (seen === "nav-connection-lost") {
    throw new Error(`the app showed its error screen: "${(await (await byId("nav-connection-lost")).getText()).replace(/\s+/g, " ")}"`);
  }
  await waitReady(60_000);
}

/** Open a page from the header and wait until the window is on it. */
export async function goto(navId: string, path: string) {
  await click(navId);
  await browser.waitUntil(async () => (await browser.execute(() => location.pathname)) === path, { timeout: 30_000, timeoutMsg: `the window never reached ${path}` });
}

/** The position of the first row with this test id whose text contains `text`, or -1. */
export const rowIndex = (id: string, text: string) =>
  browser.execute((i: string, t: string) => [...document.querySelectorAll(`[data-testid="${i}"]`)].findIndex((r) => (r as HTMLElement).innerText.includes(t)), id, text);

/** Until the header shows the Vault test identity's name: the app is signed in. */
export async function waitSignedIn(timeout = COLD_START_MS) {
  const name = await byId("nav-profile-name");
  await timed("header name", () => browser.waitUntil(async () => (await name.isDisplayed().catch(() => false)) && (await name.getText()).trim() === E2E_NAME, {
    timeout, interval: 3_000, timeoutMsg: `the header never showed "${E2E_NAME}"`,
  }));
}

/** Choose a tab of the Notes page and wait until the page speaks of it. The
 *  list itself loads after that: wait for the row or the state you expect. */
export async function openNotesTab(which: "board" | "mine") {
  const says = which === "board" ? "Everyone using this app can read the board" : "Only you can read these";
  await click(`notes-tab-${which}`);
  await browser.waitUntil(async () => (await (await byId("notes-about")).getText()).includes(says), { timeout: 30_000, timeoutMsg: `the Notes page never showed the ${which} tab` });
}

/** The row of the note whose text contains `text` (a note's text is unique in
 *  a spec), as one selector: the list is drawn again every ten seconds, so a
 *  row is never found first and used later. */
export const noteRow = (text: string) => `//li[@data-testid="notes-row"][.//*[@data-testid="notes-row-text"][contains(., "${text}")]]`;
/** An element of that row, by its test id. */
export const inNoteRow = (text: string, id: string) => $(`${noteRow(text)}//*[@data-testid="${id}"]`);
export async function waitNoteListed(text: string, timeout = 120_000) {
  await (await $(noteRow(text))).waitForDisplayed({ timeout, timeoutMsg: `the note "${text}" was never listed` });
}
export async function waitNoteGone(text: string, timeout = 120_000) {
  await (await $(noteRow(text))).waitForExist({ timeout, reverse: true, timeoutMsg: `the note "${text}" stayed listed` });
}

/** Watch for `ms` that something does NOT come up (an offer that is made a
 *  moment after the list is read): fails the moment it shows. */
export async function neverShows(id: string, ms: number, what: string) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await (await byId(id)).isExisting()) throw new Error(`${what}: ${id} showed`);
    await browser.pause(1_000);
  }
}

/** copyProblems for a screen that also shows people's own words (the text
 *  of notes): those elements are left out. */
export async function copyProblemsOutside(where: string, userContentIds: string[]): Promise<string[]> {
  const text = await browser.execute((ids: string[]) => {
    let t = document.body.innerText;
    for (const id of ids) document.querySelectorAll(`[data-testid="${id}"]`).forEach((el) => { t = t.replace((el as HTMLElement).innerText, ""); });
    return t;
  }, userContentIds);
  return copyProblemsIn(text, where);
}


// ── Does what is on the screen make sense? ──────────────────────────────
// The rulebook is src/lib/sense.ts. Here it reads the real window: the
// header, the banners and each page read the same facts through separate
// reads and timers, so they can tell two stories at once.

/** What the window shows right now, as far as the rulebook reads it. */
export async function shownNow(): Promise<Shown> {
  return (await browser.execute(() => {
    const q = (id: string, root: ParentNode = document) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    const all = (id: string) => Array.from(document.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
    const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText || "").replace(/\s+/g, " ").trim();
    const up = (id: string) => !!q(id);
    const out: Record<string, unknown> = {};
    const name = q("nav-profile-name");
    // The header is there once the app is past its start screens.
    if (up("nav-settings")) {
      out.header = { signIn: up("nav-signin"), name: name ? text(name) : null, nameStruck: !!name && /line-through/.test(name.className), restartToUpdate: up("nav-restart-to-update") };
      out.banners = { mismatch: up("nav-mismatch-banner"), reconnect: up("nav-reconnect-banner"), confirm: up("nav-link-banner") };
    }
    if (up("identity-linked") || up("identity-signed-out")) {
      out.identity = { signedIn: up("identity-linked"), signedOut: up("identity-signed-out"), name: q("identity-display-name") ? text(q("identity-display-name")) : null };
    }
    if (up("notes-about")) {
      const list = q("notes-list");
      out.notes = {
        rows: all("notes-row").length,
        counted: list ? Number(list.dataset.count) : null,
        loading: up("notes-loading"),
        empty: up("notes-empty"),
        signedOutNotice: up("notes-signed-out"),
        form: up("notes-text"),
        setUp: up("notes-set-up"),
        restoreOffer: up("notes-restore"),
        changeButtons: all("notes-row-edit").length,
      };
    }
    const auto = q("updates-auto");
    if (auto) out.updates = { autoOn: auto.getAttribute("aria-checked") === "true" };
    // The app's own wording only (a note's text is the person's).
    const own = ["nav-starting", "nav-connecting", "nav-connection-lost", "nav-mismatch-banner", "nav-reconnect-banner", "nav-link-banner", "notes-about", "notes-signed-out", "notes-set-up", "notes-restore", "notes-restored", "notes-empty", "identity-backups", "identity-success", "identity-error", "updates-card"];
    out.texts = [...own.flatMap((id) => all(id)), ...all("notes-row-meta")].map((el) => text(el)).filter(Boolean);
    return out;
  })) as Shown;
}

/** What does not make sense and stays that way: a problem counts only when
 *  every look over the next while still shows it (the header re-reads the
 *  connection every 15 s, the Notes page its list every 10 s). */
export async function senseProblemsOn(where: string): Promise<string[]> {
  const first = await shownNow();
  const h = first.header;
  console.log(
    `e2e: sense check ${where}: ${h ? (h.signIn ? "signed out" : `signed in as "${h.name}"${h.nameStruck ? " (struck)" : ""}`) : "a start screen"}` +
      `${first.identity ? ", Identity page" : ""}${first.notes ? `, Notes page (${first.notes.rows} rows)` : ""}, ${(first.texts ?? []).length} texts`,
  );
  let standing = senseProblems(first);
  for (let look = 0; look < 8 && standing.length > 0; look++) {
    await browser.pause(5_000);
    const now = senseProblems(await shownNow());
    standing = standing.filter((p) => now.includes(p));
  }
  return standing.map((p) => `${where}: ${p}`);
}

// After every test of every spec the window is checked where the test left
// it; the spec fails at its end if anything did not make sense.
const senseSeen: string[] = [];
if (typeof afterEach === "function" && typeof after === "function") {
  afterEach(async function () {
    try {
      senseSeen.push(...(await senseProblemsOn(`after "${this.currentTest?.title ?? "a test"}"`)));
    } catch {
      /* the window is gone or mid-navigation: nothing to read */
    }
  });
  after(function () {
    // STARTER_E2E_SENSE_SELFTEST=1 proves the spec fails when something is found.
    if (process.env.STARTER_E2E_SENSE_SELFTEST) senseSeen.push("self-test: a made-up problem");
    if (senseSeen.length > 0) throw new Error(`The screen showed things that do not make sense:\n  ${[...new Set(senseSeen)].join("\n  ")}`);
  });
}

/** Files the vault specs leave for a later spec (the run's own folder). */
export const PROFILE = resolve(import.meta.dirname ?? ".", "..", "profile");

