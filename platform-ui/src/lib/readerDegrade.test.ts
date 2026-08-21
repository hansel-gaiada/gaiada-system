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
// WHY IT READS THE SOURCE INSTEAD OF CALLING THE HELPERS. There are SIX near-duplicate helpers
// (`safe` in people/pipeline/portal-data/webdevChangeRequests, `skipMissing` in adminData —
// meetings.ts no longer has one: AGN-3 migrated it onto `readResult` and deleted its copy),
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
    "TRACKED, not accepted. Narrowed from a bare `catch {}` (which swallowed 500s, timeouts and " +
    "parse errors too) to absence + 403. Rethrowing 403 needs the plan's action item 4 (a shared typed-refusal component) " +
    "first, or a quietly-empty panel becomes a crashed page — worse for the viewer, no more honest.",
  "pipeline.ts": "PRE-EXISTING. Not yet swept; same action-item-4 dependency as people.ts.",
  "webdevChangeRequests-data.ts": "PRE-EXISTING. Not yet swept; same action-item-4 dependency.",
};

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
    const re = /async function (safe|skipMissing)\b[\s\S]*?\n}/g;
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
    ).toBeGreaterThanOrEqual(5);
  });

  it("🔴 no helper swallows EVERY error — a bare `catch` hides 500s, timeouts and outright bugs", () => {
    const bare = helpers().filter((h) => /catch\s*(\(\s*\w*\s*\))?\s*\{\s*return/.test(h.body) && !/instanceof/.test(h.body));
    expect(
      bare.map((h) => h.file),
      "these helpers degrade on ANY exception. That is not a refusal policy, it is a blindfold: a " +
        "5xx, a network timeout and a JSON parse error all render as 'there is nothing here'. " +
        "Discriminate on PlatformError.status, as adminData.ts's skipMissing() does.",
    ).toEqual([]);
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
