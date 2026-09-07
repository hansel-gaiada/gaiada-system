// AD-6/AD-3 seam guard — every `answers.<key>` the convert spawner reads MUST be a real
// questionnaire field id.
//
// ── WHY THIS FILE EXISTS (a bug that actually happened, 2026-09-05) ──────────────────────────────
// The convert spawner (`agency-lead-convert.service.ts`) renders the PRD and the scope note out of
// the prospect's own answers. It was written from the design doc's PROSE, before the questionnaire
// module existed, so its key names were inferred rather than checked. Three of them were wrong:
//
//     answers.audience       ->  the real id is  primary_audience
//     answers.features       ->  the real id is  features_required
//     answers.out_of_scope   ->  the real id is  out_scope
//
// Nothing failed. `fmtField(undefined)` renders the "_Not answered._" placeholder, which is exactly
// what a genuinely unanswered field renders, so the requirement doc the CLIENT SIGNS would have
// silently lost its audience, its feature list and its out-of-scope section — the three things a
// scope dispute is actually about. This is CLAUDE.md's "a missing field reads exactly like NULL"
// trap landing on the highest-stakes artifact in the flow.
//
// A unit test of the renderer cannot catch it: the renderer's own fixtures use whatever keys the
// renderer reads, so they agree with each other and both are wrong together. The only thing that
// catches it is comparing the renderer against the QUESTIONNAIRE, which is what this file does.
//
// ── WHY IT PARSES SOURCE INSTEAD OF IMPORTING A CONSTANT ─────────────────────────────────────────
// A shared `KEYS` constant would be the tidier design, but it would also be the thing a future
// author bypasses the moment they write `answers.something_new` inline — and that write is exactly
// the mistake this guard exists to catch. Reading the source text catches the inline access too.
// It is a coarse instrument on purpose.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_QUESTIONNAIRE_FIELDS, SCHEMA_VERSION } from "./agency-discovery-questionnaire";

/** Files that read a prospect's submitted answers by key. Add to this list, never remove from it. */
const ANSWER_READERS = ["agency-lead-convert.service.ts"];

/** `answers.foo` and `answers["foo"]` / `answers['foo']`. */
const DOT = /\banswers\.([A-Za-z_][A-Za-z0-9_]*)/g;
const BRACKET = /\banswers\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g;

/** Properties of the answers OBJECT itself, not answer ids — reading these is not a field access. */
const NOT_FIELD_IDS = new Set(["length", "constructor", "hasOwnProperty", "toString", "valueOf"]);

function keysReadBy(file: string): string[] {
  const src = readFileSync(join(__dirname, file), "utf8");
  const found = new Set<string>();
  for (const re of [DOT, BRACKET]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      if (!NOT_FIELD_IDS.has(m[1])) found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe("AD-3/AD-6 seam — answer keys are real questionnaire field ids", () => {
  const validIds = new Set(ALL_QUESTIONNAIRE_FIELDS.map((f) => String(f.id)));

  it("the questionnaire actually exposes ids to check against", () => {
    // Guards the guard: if the questionnaire module ever stops exporting fields, every assertion
    // below would pass vacuously and this file would go quiet exactly when it is most needed.
    expect(validIds.size).toBeGreaterThan(100);
    expect(SCHEMA_VERSION).toMatch(/^agency-discovery\./);
  });

  for (const file of ANSWER_READERS) {
    it(`${file} reads only ids that exist in the questionnaire`, () => {
      const read = keysReadBy(file);
      expect(read.length).toBeGreaterThan(0); // the reader must actually read something

      const unknown = read.filter((k) => !validIds.has(k));
      expect(
        unknown,
        `${file} reads answer key(s) that no questionnaire field defines: ${unknown.join(", ")}.\n` +
          "These render as \"_Not answered._\" — indistinguishable from a question the prospect " +
          "genuinely skipped — so the client signs a requirement doc with a silently empty section.\n" +
          "Either the key is a typo, or the questionnaire field was renamed and this reader was " +
          "not updated. Fix the reader; do not add the id to the questionnaire to make this pass.",
      ).toEqual([]);
    });
  }

  it("the three ids that caused this bug are still spelled correctly", () => {
    // A regression pin. If someone reinstates the inferred spellings, the loop above catches it,
    // but this names the specific failure so the next reader does not have to re-derive it.
    for (const real of ["primary_audience", "features_required", "out_scope"]) {
      expect(validIds.has(real), `questionnaire lost the field id "${real}"`).toBe(true);
    }
    for (const wrong of ["audience", "features", "out_of_scope"]) {
      expect(validIds.has(wrong), `"${wrong}" is the INFERRED spelling and must never exist`).toBe(false);
    }
  });
});
