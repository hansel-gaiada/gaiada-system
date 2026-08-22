// AGN-3 — the reader-degrade invariant, pinned as a static sweep over the source.
//
// WHY THIS FILE EXISTS. The agentic-native plan's READINESS BAR, criterion 5 — "Explicit
// refusal ... Never an empty list that reads as 'no data'", whose stated failure signal is
// literally "403/404 collapsed into `[]` by the reader". Restated in the exit bar as item 4: "Refusal is explicit
// everywhere; no reader folds a denial into an empty list." Its own action item 3 says to "sweep
// every `safe()`/`skipMissing()` call site and make the refusal explicit", and records what the
// defect actually cost: **the client portal told staff "your kickoff is being processed"** when the
// truth was that the read had been refused. An empty list is a CLAIM. Rendering one on the strength
// of a caught exception asserts "there is nothing here" from evidence that says nothing of the kind.
//
// ⚠ THE SWEEP ITSELF WAS INCOMPLETE, WHICH IS THE BEST ARGUMENT FOR HAVING IT. It matched `safe`
// and `skipMissing` because the plan named those two — and `queue.ts` had a THIRD copy called
// `settle()`, whose own comment approvingly described the whole defect chain ("the underlying
// readers already degrade 404/403 to [] themselves; this is the outer net for anything else").
// A pattern with three names in one codebase is not going to be found by remembering names, so
// the regex now covers all three and this note exists to make the next rename obvious.
//
// WHY IT READS THE SOURCE INSTEAD OF CALLING THE HELPERS. There are SIX near-duplicate helpers
// (`safe` in people/portal-data, `skipMissing` in adminData, `settle` in queue.ts — meetings.ts,
// pipeline.ts and webdevChangeRequests-data.ts no longer have one: AGN-3 migrated them onto
// `readResult` and deleted their copies. people.ts keeps one for a genuine FALLBACK CHAIN only),
// each private to its own module and each with SUBTLY DIFFERENT rules —
// which is exactly how they drifted apart unnoticed. A behavioural test could only reach the ones a
// module chooses to export; a source sweep sees all of them, including the seventh someone adds next
// month by copy-pasting the worst one. That is the failure mode being guarded.
//
// WHAT IS ALLOWED, AND WHY IT IS AN ALLOW-LIST RATHER THAN A RULE:
//   - 404 / 405 — genuine absence, or a route this deployment does not serve. Degrading is correct.
//   - 403 — a DENIAL. Degrading is the defect. Every current offender is listed below with its
//     reason, so the list can only shrink deliberately; it is not a blanket exemption.
//
// `webdevProvisionedSites-data.ts` is deliberately NOT in this sweep: it hand-rolls its reads and
// documents, at length, why it refuses to fold 403 into 404 — the model the others should converge
// on, alongside `it-accounts.ts`'s discriminated `ok | unavailable | forbidden`. My first draft
// listed it as an offender; the staleness check below caught that on its first run.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LIB = join(__dirname);

/** Files permitted to degrade a 403, each for a stated reason. Shrink this; never grow it silently. */
const DEGRADES_403_KNOWN: Record<string, string> = {
  "portal-data.ts":
    "DELIBERATE and documented in-file: a staff member browsing /portal is not a client contact, so " +
    "the LIST routes teach rather than refuse. The one reasoned exception, not an oversight.",
  "people.ts":
    "NOW A FALLBACK CHAIN, not a panel degrade — the reason changed, so this entry did too. Its six " +
    "PANELS moved to readResult and report refusals to the page (KPIs show a dash, panels render " +
    "<ReadRefusal>). What still swallows a 403 is `resolveProfile`, which tries /users (carries " +
    "roles) and falls back to /members (any member can read it): a 403 on the first is not a " +
    "failure there, it is why the second exists. 🔴 Residual, recorded at the helper: if BOTH are " +
    "refused, getEmployee returns null and the page says 'Person not found' — the same conflation " +
    "one level up, mitigated by canViewEmployee gating the page first.",
};

/**
 * Helpers permitted to catch EVERYTHING, each for a stated reason. Separate from
 * DEGRADES_403_KNOWN because it is a different and wider defect: a 403-degrader at least knows what
 * it swallowed, whereas a bare catch cannot tell a denial from a crash.
 */
const BARE_CATCH_KNOWN: Record<string, string> = {
  "queue.ts":
    "`settle()` — still catches broadly, by design, but the SILENCE is gone. UX-2 §1.5 requires that " +
    "one dead source must not blank the queue, so the try/catch stays; what changed (AGN-3) is that " +
    "each source NAMES itself, a failed one lands in `EnvelopeCompany.partialSources`, and " +
    "EnvelopeBanner renders 'This list is incomplete — treat an empty or short result as unknown " +
    "rather than settled'. Surviving a dead source is no longer indistinguishable from succeeding, " +
    "which was the actual defect.",
};


/**
 * A bare catch is one that does not DISCRIMINATE — it has a catch clause and never inspects what it
 * caught, so a 403, a 500 and a parse error are one outcome.
 *
 * ⚠ The first version matched `catch {` followed IMMEDIATELY by `return`, which was a shape test
 * masquerading as a semantic one. When AGN-3 added a `lost.push(source)` line before the return in
 * `queue.ts`'s `settle()`, that helper stopped being detected at all — the check went quiet on a
 * helper that still catches everything. Keyed on the absence of `instanceof` instead, which is the
 * property that actually matters.
 */
function isBareCatch(body: string): boolean {
  // NO REGEX HERE, ON PURPOSE. Two successive attempts to write a word boundary in this predicate
  // produced literal BACKSPACE bytes instead, giving a pattern that matches nothing — so the check
  // went silently green while queue.ts's bare catch sat directly in front of it. That is the same
  // trap driversFor() in capability-inventory.test.ts documents, reintroduced twice by the tooling
  // writing this file. A substring test cannot be mis-escaped, and "does this helper contain a
  // catch clause" needs nothing cleverer.
  return body.includes("catch") && !body.includes("instanceof");
}


interface Helper {
  file: string;
  body: string;
}

/** Every `safe`/`skipMissing` helper definition in lib/, with its body. */
function helpers(): Helper[] {
  const out: Helper[] = [];
  for (const file of readdirSync(LIB)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(LIB, file), "utf8");
    const re = /async function (safe|skipMissing|settle)\b[\s\S]*?\n}/g;
    for (const m of src.matchAll(re)) out.push({ file, body: m[0] });
  }
  return out;
}

describe("AGN-3 · the reader-degrade invariant", () => {
  it("finds the degrade helpers at all — a sweep that matches nothing would pass vacuously", () => {
    const found = helpers();
    // Positive control FIRST, per this estate's defining failure mode: if the regex stops matching
    // (someone renames the helpers, or reformats them across lines), every assertion below becomes
    // trivially true and this file turns into a green rubber stamp.
    expect(
      found.length,
      "no safe()/skipMissing() helpers matched — the sweep is broken, not the estate clean",
    ).toBeGreaterThanOrEqual(3);
  });

  it("🔴 no NEW helper swallows every error — a bare `catch` hides 500s, timeouts and outright bugs", () => {
    const bare = helpers()
      .filter((h) => isBareCatch(h.body))
      .map((h) => h.file)
      .filter((f) => !(f in BARE_CATCH_KNOWN));
    expect(
      bare,
      "these helpers degrade on ANY exception. That is not a refusal policy, it is a blindfold: a " +
        "5xx, a network timeout and a JSON parse error all render as 'there is nothing here'. " +
        "Discriminate on PlatformError.status, as adminData.ts's skipMissing() does.",
    ).toEqual([]);
  });

  it("the bare-catch allow-list has no stale entries either", () => {
    const bare = new Set(
      helpers()
        .filter((h) => isBareCatch(h.body))
        .map((h) => h.file),
    );
    expect(Object.keys(BARE_CATCH_KNOWN).filter((f) => !bare.has(f))).toEqual([]);
  });

  it("every helper that degrades a 403 is on the known list, with a recorded reason", () => {
    const offenders = helpers()
      .filter((h) => /403/.test(h.body))
      .map((h) => h.file);
    const undocumented = offenders.filter((f) => !(f in DEGRADES_403_KNOWN));
    expect(
      undocumented,
      "a NEW reader is folding a denial into a fallback. Readiness-bar criterion 5 calls this the " +
        "single worst agentic failure mode; the cost of getting this wrong is already recorded (the " +
        "client portal told staff 'your kickoff is being processed'). Either make the refusal " +
        "explicit, or add the file here WITH a reason.",
    ).toEqual([]);
  });

  it("the known-offender list has no stale entries — a swept file must be removed from it", () => {
    // Keeps the list honest in the other direction: once a file is fixed, leaving it listed would
    // let a future regression re-introduce the defect silently under cover of an old exemption.
    const offenders = new Set(helpers().filter((h) => /403/.test(h.body)).map((h) => h.file));
    const stale = Object.keys(DEGRADES_403_KNOWN).filter((f) => !offenders.has(f));
    expect(
      stale,
      "these files no longer degrade a 403 — remove them from DEGRADES_403_KNOWN so the exemption " +
        "cannot shelter a future regression",
    ).toEqual([]);
  });

  it("adminData.ts's skipMissing stays the reference shape: absence only, never a denial", () => {
    const ref = helpers().find((h) => h.file === "adminData.ts");
    expect(ref, "adminData.ts's skipMissing() is the pattern the others are measured against").toBeTruthy();
    expect(ref!.body).toMatch(/instanceof PlatformError/);
    expect(
      /403/.test(ref!.body),
      "skipMissing() started degrading a 403 — the one helper that was already correct is the one " +
        "every other file is supposed to converge on",
    ).toBe(false);
  });
});
