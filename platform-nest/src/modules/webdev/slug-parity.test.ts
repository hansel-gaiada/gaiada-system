// PRV-02 — slug parity against the SHIPPED delivery workflow (design D-P8).
//
// The claim this file defends: once `provision` has run, the existing `release_code` beat's
// `github.repoStatus(repo: slug)` gate passes with ZERO workflow changes. That is true only while
// `deriveRunSlug()` and `pipeline-delivery.json`'s own expression agree byte for byte.
//
// The test EXTRACTS AND EXECUTES the workflow's expression rather than restating it. A hand-copied
// expectation drifts in exactly the same way the code it guards would, and would keep passing while
// the real workflow diverged — which is the failure this file exists to make impossible.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveRunSlug, isValidProvisionSlug } from "./slug";

const WORKFLOW = join(__dirname, "..", "..", "..", "..", "automation", "workflows", "pipeline-delivery.json");

/** Pull the literal `const slug=...` expression out of the workflow's "Load + decide" Code node. */
function workflowSlugExpression(): string {
  const doc = JSON.parse(readFileSync(WORKFLOW, "utf8")) as { nodes?: Array<{ parameters?: { jsCode?: string } }> };
  const codes = (doc.nodes ?? []).map((n) => n.parameters?.jsCode).filter((s): s is string => typeof s === "string");
  const node = codes.find((s) => s.includes("const slug="));
  if (!node) throw new Error("no workflow node defines `const slug=` — the parity anchor moved");
  const m = /const slug=([^;]+);/.exec(node);
  if (!m) throw new Error("found `const slug=` but could not extract the expression");
  return m[1];
}

/** The workflow's own derivation, executed. `run` is the shape its `pipeline.getRun` returns. */
function workflowDerive(run: { title: string | null; id: string }): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function("run", `return ${workflowSlugExpression()}`) as (r: unknown) => string;
  return fn(run);
}

describe("PRV-02 — deriveRunSlug parity with automation/workflows/pipeline-delivery.json", () => {
  it("the anchor exists — a test that cannot find the workflow expression proves nothing", () => {
    const expr = workflowSlugExpression();
    expect(expr).toContain("toLowerCase()");
    expect(expr).toContain("slice(0,40)");
  });

  const cases: Array<{ why: string; title: string | null; id: string }> = [
    { why: "ordinary title", title: "Acme Corp Website Revamp", id: "0198c9d1-0000-7000-8000-000000000001" },
    { why: "punctuation collapses to single hyphens", title: "Acme, Inc. — Site (v2)!", id: "0198c9d1-0000-7000-8000-000000000002" },
    { why: "leading/trailing separators", title: "  --Acme--  ", id: "0198c9d1-0000-7000-8000-000000000003" },
    // The workflow strips ONE leading and ONE trailing hyphen, not runs of them. An "improved"
    // /^-+|-+$/ here would pass a hand-written expectation and fail this one.
    { why: "double leading/trailing hyphen keeps the inner one", title: "--Acme--", id: "0198c9d1-0000-7000-8000-000000000004" },
    { why: "over 40 chars truncates AFTER trimming", title: "A really long client project title that definitely exceeds the cap", id: "0198c9d1-0000-7000-8000-000000000005" },
    { why: "unicode is not transliterated", title: "Café Ñandú 网站", id: "0198c9d1-0000-7000-8000-000000000006" },
    { why: "digits survive", title: "Project 2026 Q3", id: "0198c9d1-0000-7000-8000-000000000007" },
    { why: "empty title falls back to run-<id>", title: "", id: "0198c9d1-0000-7000-8000-000000000008" },
    { why: "null title falls back to run-<id>", title: null, id: "0198c9d1-0000-7000-8000-000000000009" },
    { why: "punctuation-only title collapses to empty", title: "!!!", id: "0198c9d1-0000-7000-8000-00000000000a" },
    { why: "already-slug title is idempotent", title: "acme-corp-site", id: "0198c9d1-0000-7000-8000-00000000000b" },
  ];

  for (const c of cases) {
    it(`matches the workflow: ${c.why}`, () => {
      expect(deriveRunSlug(c.title, c.id)).toBe(workflowDerive({ title: c.title, id: c.id }));
    });
  }

  it("the `run-<uuid>` fallback fits the 40-char cap exactly (not by luck going forward)", () => {
    const id = "0198c9d1-0000-7000-8000-00000000000c";
    const slug = deriveRunSlug(null, id);
    expect(slug).toBe(`run-${id}`);
    expect(slug.length).toBe(40);
    // If the cap ever shrinks, the fallback starts TRUNCATING a uuid — two runs whose ids share a
    // prefix would then collide on one provision project name. This assertion is the tripwire.
    expect(isValidProvisionSlug(slug)).toBe(true);
  });

  it("a punctuation-only title yields an EMPTY slug, which is invalid rather than silently rescued", () => {
    // Deliberate: substituting `run-<id>` here would provision a repo under a name the requester
    // never chose. The endpoint answers 422 invalid_slug and the caller supplies an override.
    expect(deriveRunSlug("!!!", "0198c9d1-0000-7000-8000-00000000000d")).toBe("");
    expect(isValidProvisionSlug("")).toBe(false);
  });

  it("every derived slug that is non-empty satisfies provision's own grammar", () => {
    for (const c of cases) {
      const slug = deriveRunSlug(c.title, c.id);
      if (slug) expect(isValidProvisionSlug(slug), `${c.why} -> ${slug}`).toBe(true);
    }
  });

  it("rejects slugs provision's `/bin/sh -c` heredoc could not safely carry", () => {
    for (const bad of ["Acme", "acme site", "acme/../etc", "acme;rm -rf /", "acme$(id)", "a".repeat(41), "acme_site"]) {
      expect(isValidProvisionSlug(bad), bad).toBe(false);
    }
  });
});
