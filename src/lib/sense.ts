// What a person would call "that does not make sense": two things on the
// screen that cannot both be true, or a sentence no person would write.
// It reads only what is SHOWN, so the same checks run in a unit test over
// screens written out by hand (sense.test.ts) and over the real window in
// the UI suite (e2e/specs/_helpers.ts). The header, the banners and each
// page read the same facts through separate reads and timers; this is where
// they are held to one story.
//
// When someone sees a screen that does not make sense, the check goes in
// here first, with the screen they saw as its test. Then the fix.

export interface Shown {
  /** The header. `name`: the profile name shown; `nameStruck`: shown struck through (another identity is in the Vault). */
  header?: { signIn: boolean; name: string | null; nameStruck: boolean; restartToUpdate: boolean };
  /** Banners under the header. */
  banners?: { mismatch: boolean; reconnect: boolean; confirm: boolean };
  /** The Identity page, when it is the page shown. */
  identity?: { signedIn: boolean; signedOut: boolean; name: string | null };
  /** The Notes page. `counted`: the list's own count; `rows`: the rows drawn. */
  notes?: { rows: number; counted: number | null; loading: boolean; empty: boolean; signedOutNotice: boolean; form: boolean; setUp: boolean; changeButtons: number; restoreOffer?: boolean };
  /** Settings > Updates: the automatic-updates switch. */
  updates?: { autoOn: boolean };
  /** Status text on the screen that is the app's own wording (never what a person typed). */
  texts?: string[];
}

/** Sentences no person would write. */
const ODD_TEXT: [RegExp, string][] = [
  [/\b1 (notes|records|minutes|devices|bytes)\b/, "a plural after 1"],
  [/\b0 of 0\b/, '"0 of 0"'],
  [/after 0 minutes/, "a wait of 0 minutes"],
  [/(^|[^\w.])-\d/, "a negative number"],
  [/Invalid Date|\bnull\b|\bundefined\b|\bNaN\b/, "a programming leftover"],
  [/—/, "an em dash"],
];

export function senseProblems(s: Shown): string[] {
  const out: string[] = [];
  const h = s.header;
  const signedInHeader = !!h && h.name !== null && !h.nameStruck;

  if (h) {
    if (h.signIn && h.name !== null) out.push(`the header offers to sign in and shows a signed-in name ("${h.name}")`);
    if (h.signIn && s.banners && (s.banners.reconnect || s.banners.confirm)) out.push("the header offers to sign in while a banner speaks of this app's connection to the Vault");
    if (h.nameStruck && s.banners && !s.banners.mismatch) out.push("the header strikes through the name while no banner says the Vault holds another identity");
    if (s.identity) {
      if (h.signIn && s.identity.signedIn) out.push("the header offers to sign in while the Identity page says signed in with Flowsta");
      if (signedInHeader && s.identity.signedOut) out.push(`the header shows "${h.name}" as signed in while the Identity page asks to connect a Flowsta account`);
      if (signedInHeader && s.identity.signedIn && s.identity.name && s.identity.name !== "Flowsta Account" && s.identity.name !== h.name) {
        out.push(`the header names "${h.name}" and the Identity page names "${s.identity.name}"`);
      }
    }
    if (s.notes) {
      if (h.signIn && s.notes.form) out.push("the header offers to sign in while the Notes page shows the form to write a note");
      if (h.signIn && s.notes.changeButtons > 0) out.push("the header offers to sign in while notes offer Edit and Delete");
      if (signedInHeader && s.notes.signedOutNotice) out.push(`the header shows "${h.name}" as signed in while the Notes page asks to sign in`);
    }
    if (s.updates && h.restartToUpdate && !s.updates.autoOn) out.push('the header offers "Restart to update" while automatic updates are switched off (the waiting download was dropped)');
  }
  if (s.identity && s.identity.signedIn && s.identity.signedOut) out.push("the Identity page shows signed in and signed out at once");
  if (s.banners?.mismatch && s.notes?.form) out.push("a banner says the Vault holds another identity while the Notes page shows the form to write a note");

  if (s.notes) {
    const n = s.notes;
    const states = [n.loading && "loading", n.empty && "no notes yet", n.setUp && "private notes not set up"].filter(Boolean) as string[];
    if (n.rows > 0 && states.length > 0) out.push(`the Notes page lists ${n.rows} note${n.rows === 1 ? "" : "s"} and says ${states.join(" and ")}`);
    if (states.length > 1) out.push(`the Notes page says ${states.join(" and ")} at once`);
    if (n.counted !== null && n.counted !== n.rows) out.push(`the Notes list counts ${n.counted} and shows ${n.rows}`);
    if (n.setUp && n.form) out.push("the Notes page asks to set up private notes and shows the form to write one");
    if (n.signedOutNotice && n.form) out.push("the Notes page asks to sign in and shows the form to write a note");
    if (n.restoreOffer && (n.setUp || n.signedOutNotice)) out.push(`the Notes page offers to restore notes from the Vault backup and ${n.setUp ? "asks to set up private notes" : "asks to sign in"}`);
  }

  for (const t of s.texts ?? []) {
    for (const [re, what] of ODD_TEXT) {
      if (re.test(t)) out.push(`${what}: "${t.length > 140 ? `${t.slice(0, 140)}...` : t}"`);
    }
  }
  return [...new Set(out)];
}
