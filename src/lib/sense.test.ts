// The rulebook over screens written out by hand: each fault it must catch,
// and the ordinary screens it must leave alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { senseProblems, type Shown } from "./sense";

const header = (over: Partial<NonNullable<Shown["header"]>> = {}) => ({ signIn: false, name: "Ada", nameStruck: false, restartToUpdate: false, ...over });
const signedOutHeader = () => header({ signIn: true, name: null });
const noBanners = { mismatch: false, reconnect: false, confirm: false };
const notes = (over: Partial<NonNullable<Shown["notes"]>> = {}) => ({ rows: 0, counted: null, loading: false, empty: false, signedOutNotice: false, form: true, setUp: false, changeButtons: 0, ...over });
const has = (s: Shown, re: RegExp) => assert.ok(senseProblems(s).some((p) => re.test(p)), `expected ${re} in:\n${senseProblems(s).join("\n") || "(nothing found)"}`);

test("ordinary screens make sense", () => {
  const ok: Shown[] = [
    { header: signedOutHeader(), banners: noBanners, identity: { signedIn: false, signedOut: true, name: null }, texts: ["Connect your Flowsta account"] },
    { header: header(), banners: noBanners, identity: { signedIn: true, signedOut: false, name: "Ada" }, texts: ["Last backup saved at 10:42."] },
    // Signed out on the board: reading works, no form, the notice asks to sign in.
    { header: signedOutHeader(), banners: noBanners, notes: notes({ rows: 2, counted: 2, form: false, signedOutNotice: true }) },
    { header: signedOutHeader(), banners: noBanners, notes: notes({ empty: true, form: false, signedOutNotice: true }), texts: ["No notes on the board yet."] },
    // Signed in: the form, the list, Edit and Delete on the person's own.
    { header: header(), banners: noBanners, notes: notes({ rows: 3, counted: 3, changeButtons: 2 }), texts: ["You · 3 min ago", "You · just now · edited"] },
    { header: header(), banners: noBanners, notes: notes({ loading: true }) },
    // My notes before this device joined the person's own network.
    { header: header(), banners: noBanners, notes: notes({ setUp: true, form: false }) },
    { header: header({ restartToUpdate: true }), banners: noBanners, updates: { autoOn: true } },
    // The Vault holds another identity: the name is struck through, the banner says why, notes are read-only.
    { header: header({ nameStruck: true }), banners: { ...noBanners, mismatch: true }, notes: notes({ rows: 2, counted: 2, form: false, signedOutNotice: true }) },
  ];
  for (const s of ok) assert.deepEqual(senseProblems(s), [], JSON.stringify(s));
});

test("signed in on one part of the screen and signed out on another", () => {
  has({ header: signedOutHeader(), identity: { signedIn: true, signedOut: false, name: "Ada" } }, /offers to sign in while the Identity page says signed in/);
  has({ header: header(), identity: { signedIn: false, signedOut: true, name: null } }, /as signed in while the Identity page asks to connect/);
  has({ header: header(), identity: { signedIn: true, signedOut: false, name: "Grace" } }, /names "Ada" and the Identity page names "Grace"/);
  has({ header: header({ signIn: true }) }, /offers to sign in and shows a signed-in name/);
  has({ header: signedOutHeader(), notes: notes({ form: true }) }, /offers to sign in while the Notes page shows the form/);
  has({ header: signedOutHeader(), notes: notes({ form: false, rows: 1, counted: 1, changeButtons: 1 }) }, /offers to sign in while notes offer Edit and Delete/);
  has({ header: header(), notes: notes({ form: false, signedOutNotice: true }) }, /as signed in while the Notes page asks to sign in/);
  has({ header: signedOutHeader(), banners: { ...noBanners, reconnect: true } }, /offers to sign in while a banner speaks of this app's connection/);
  has({ identity: { signedIn: true, signedOut: true, name: null } }, /signed in and signed out at once/);
});

test("another identity in the Vault", () => {
  has({ header: header({ nameStruck: true }), banners: noBanners }, /strikes through the name while no banner/);
  has({ header: header({ nameStruck: true }), banners: { ...noBanners, mismatch: true }, notes: notes({ form: true }) }, /holds another identity while the Notes page shows the form/);
});

test("a list that disagrees with itself", () => {
  has({ notes: notes({ rows: 2, counted: 2, empty: true }) }, /lists 2 notes and says no notes yet/);
  has({ notes: notes({ rows: 1, counted: 1, loading: true }) }, /lists 1 note and says loading/);
  has({ notes: notes({ rows: 2, counted: 3 }) }, /counts 3 and shows 2/);
  has({ notes: notes({ loading: true, empty: true }) }, /loading and no notes yet at once/);
  has({ notes: notes({ setUp: true, form: true }) }, /asks to set up private notes and shows the form/);
  has({ notes: notes({ setUp: true, form: false, restoreOffer: true }) }, /offers to restore notes from the Vault backup and asks to set up/);
  has({ notes: notes({ signedOutNotice: true, form: true }) }, /asks to sign in and shows the form/);
});

test("updates", () => {
  has({ header: header({ restartToUpdate: true }), updates: { autoOn: false } }, /Restart to update" while automatic updates are switched off/);
});

test("sentences no person would write", () => {
  has({ texts: ["1 notes"] }, /a plural after 1/);
  has({ texts: ["Last backup saved on Invalid Date."] }, /a programming leftover/);
  has({ texts: ["Saved — thank you"] }, /an em dash/);
  has({ texts: ["Waited -3 s"] }, /a negative number/);
  assert.deepEqual(senseProblems({ texts: ["You · 3 min ago", "Someone else (uhCAk4RU1...FHD) · 2 h ago"] }), []);
});
