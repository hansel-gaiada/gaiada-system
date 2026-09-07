// AD-6 — unit coverage for the agency-lead convert spawner's pure logic. NO DB: everything here is a
// pure function (input -> output, no PoolClient, no withTenants). The lock idiom itself
// (lock -> re-read -> re-check -> spawn, one transaction) and the concurrency guarantee it buys
// (two concurrent converts -> exactly one client/run, loser 409s) can only be proven against a real
// Postgres advisory lock and real concurrent transactions — see webdev-cr-race.test.ts for the shape
// that proof would take (`describe.skipIf(!TEST_URL)`, a pre-taken lock, `pg_locks` polling). This
// repo's DATABASE_URL_TEST is not set and the 16-container stack is OFF by owner decision, so that
// proof is NOT attempted here and this file's tests are the only ones actually run for this ticket.
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  AGENCY_LEAD_LOCK_NS,
  CANONICAL_DELEGATIONS,
  computeDelegationPlan,
  normalizeDelegationsInput,
  renderRequirementDoc,
  renderScopeNote,
} from "./agency-lead-convert.service";
import { getExecutable } from "./approval-executables";
import {
  isPositionResolvableRole,
  pickAllPositionHolders,
  pickPositionHolder,
  type PositionCandidateRow,
  type PositionHolderResolution,
} from "./agency-delegation-resolver";

/** No matching seat anywhere in the tenant, for tests that only care about the owner axis. */
const NO_POSITIONS: Record<"sitemap" | "integrations" | "dns", PositionHolderResolution> = {
  sitemap: { matchedPositionId: null, matchedPositionTitle: null, holderUserId: null },
  integrations: { matchedPositionId: null, matchedPositionTitle: null, holderUserId: null },
  dns: { matchedPositionId: null, matchedPositionTitle: null, holderUserId: null },
};

const LEAD = { id: "lead-1", orgName: "Bali Beach Resort", contactName: "Kadek Wirawan" };

describe("AD-6 — renderRequirementDoc / renderScopeNote", () => {
  it("renders every named section from the discovery answers", () => {
    const doc = renderRequirementDoc(LEAD, {
      objective: "Rebuild the marketing site",
      primary_audience: "Domestic + APAC travellers",
      features_required: ["booking widget", "multi-language"],
      pages_required: ["Home", "Rooms", "Contact"],
      integrations: ["Stripe", "Mailchimp"],
    });
    expect(doc).toContain("# Bali Beach Resort");
    expect(doc).toContain("Rebuild the marketing site");
    expect(doc).toContain("Domestic + APAC travellers");
    expect(doc).toContain("booking widget, multi-language");
    expect(doc).toContain("Home, Rooms, Contact");
    expect(doc).toContain("Stripe, Mailchimp");
    expect(doc).toContain("`lead-1`");
  });

  it("falls back to a 'not answered' marker per field, never 'undefined' — a missing key must not read as an empty answer", () => {
    const doc = renderRequirementDoc(LEAD, {});
    expect(doc).not.toContain("undefined");
    expect(doc.match(/_Not answered\._/g)?.length).toBe(5); // objective, primary_audience, features_required, pages_required, integrations
  });

  it("scope note covers in-scope/out-of-scope/dependencies and never embeds an estimate", () => {
    const note = renderScopeNote(LEAD, {
      in_scope: "New website, 8 pages",
      out_scope: "SEO retainer",
      dependencies: "Client to supply brand assets",
    });
    expect(note).toContain("New website, 8 pages");
    expect(note).toContain("SEO retainer");
    expect(note).toContain("Client to supply brand assets");
    expect(note.toLowerCase()).not.toMatch(/\$|idr|rp\.?\s?\d/); // no price ever appears
    expect(note).toContain("agreed separately");
  });
});

describe("AD-6 — normalizeDelegationsInput", () => {
  it("accepts undefined/null as 'no delegations'", () => {
    expect(normalizeDelegationsInput(undefined)).toEqual([]);
    expect(normalizeDelegationsInput(null)).toEqual([]);
  });

  it("rejects a non-array body", () => {
    expect(() => normalizeDelegationsInput({ role: "am" })).toThrow(BadRequestException);
  });

  it("requires assigneeId on every entry — never a silent skip (design §4.3)", () => {
    expect(() => normalizeDelegationsInput([{ role: "sitemap" }])).toThrow(BadRequestException);
    expect(() => normalizeDelegationsInput([{ role: "sitemap", assigneeId: "" }])).toThrow(BadRequestException);
  });

  it("validates dueAt shape (YYYY-MM-DD)", () => {
    expect(() => normalizeDelegationsInput([{ assigneeId: "u1", dueAt: "next friday" }])).toThrow(BadRequestException);
    expect(normalizeDelegationsInput([{ assigneeId: "u1", dueAt: "2026-09-20" }])).toEqual([
      { role: undefined, assigneeId: "u1", dueAt: "2026-09-20", title: undefined },
    ]);
  });

  it("round-trips a well-formed entry", () => {
    const out = normalizeDelegationsInput([{ role: "dns", assigneeId: "u2", title: "Confirm DNS", dueAt: "2026-10-01" }]);
    expect(out).toEqual([{ role: "dns", assigneeId: "u2", dueAt: "2026-10-01", title: "Confirm DNS" }]);
  });
});

describe("AD-6 — computeDelegationPlan (§4.3 defaults, condition-gated, caller-overridable)", () => {
  it("always seeds 'discovery_review' to the lead owner when the caller names nothing", () => {
    const plan = computeDelegationPlan({}, "owner-1", [], NO_POSITIONS);
    expect(plan).toEqual([
      {
        role: "discovery_review",
        title: CANONICAL_DELEGATIONS.discovery_review.title,
        dueAt: undefined,
        candidates: [{ source: "owner", assigneeId: "owner-1" }],
      },
    ]);
  });

  it("without a resolvable owner, the always-on task has an EMPTY candidate list rather than being silently dropped or assigned to nobody", () => {
    const plan = computeDelegationPlan({}, null, [], NO_POSITIONS);
    expect(plan).toEqual([
      { role: "discovery_review", title: CANONICAL_DELEGATIONS.discovery_review.title, dueAt: undefined, candidates: [] },
    ]);
  });

  it("condition-gates 'sitemap'/'integrations'/'dns' on the answers; with no seat holder AND no owner they still appear in the plan, unplaceable (empty candidates) rather than omitted (AD-6b closes the AD-6 gap)", () => {
    const answers = { pages_required: ["Home"], integrations: ["Stripe"], dns_owner: "registrar X" };
    const plan = computeDelegationPlan(answers, null, [], NO_POSITIONS);
    // discovery_review's condition is unconditional (`() => true`), so it is ALSO in the plan here —
    // also unplaceable, since ownerId is null too. All four appear; all four are candidate-less.
    expect(plan.map((p) => p.role).sort()).toEqual(["discovery_review", "dns", "integrations", "sitemap"]);
    for (const p of plan) expect(p.candidates).toEqual([]);
  });

  it("'sitemap'/'integrations'/'dns' fall back to the lead OWNER (flagged 'owner_fallback', not plain 'owner') when their condition fires but no seat holder resolves", () => {
    const answers = { pages_required: ["Home"], integrations: ["Stripe"], dns_owner: "registrar X" };
    const plan = computeDelegationPlan(answers, "owner-1", [], NO_POSITIONS);
    for (const role of ["sitemap", "integrations", "dns"]) {
      const p = plan.find((x) => x.role === role);
      expect(p?.candidates, `role '${role}'`).toEqual([{ source: "owner_fallback", assigneeId: "owner-1" }]);
    }
  });

  it("'sitemap' prefers a resolved PM seat holder over the owner fallback — the position candidate comes FIRST in the chain", () => {
    const answers = { pages_required: ["Home", "About"] };
    const positionHolders = {
      ...NO_POSITIONS,
      sitemap: { matchedPositionId: "pos-pm", matchedPositionTitle: "Project Manager", holderUserId: "pm-holder-1" },
    };
    const plan = computeDelegationPlan(answers, "owner-1", [], positionHolders);
    const sitemap = plan.find((p) => p.role === "sitemap");
    expect(sitemap?.candidates).toEqual([
      { source: "position", assigneeId: "pm-holder-1", positionId: "pos-pm", positionTitle: "Project Manager" },
      { source: "owner_fallback", assigneeId: "owner-1" },
    ]);
  });

  it("a caller-supplied delegation for a conditioned role creates it, with the caller's assignee as the ONLY candidate — no position/owner fallback is even attempted", () => {
    const answers = { pages_required: ["Home", "About"] };
    const positionHolders = {
      ...NO_POSITIONS,
      sitemap: { matchedPositionId: "pos-pm", matchedPositionTitle: "Project Manager", holderUserId: "pm-holder-1" },
    };
    const plan = computeDelegationPlan(answers, "owner-1", [{ role: "sitemap", assigneeId: "pm-1" }], positionHolders);
    const sitemap = plan.find((p) => p.role === "sitemap");
    expect(sitemap).toMatchObject({
      title: CANONICAL_DELEGATIONS.sitemap.title,
      candidates: [{ source: "caller", assigneeId: "pm-1" }],
    });
  });

  it("a caller override for 'discovery_review' REPLACES the owner default rather than adding a second task", () => {
    const plan = computeDelegationPlan({}, "owner-1", [{ role: "discovery_review", assigneeId: "am-2", title: "Custom title" }], NO_POSITIONS);
    expect(plan).toEqual([
      { role: "discovery_review", title: "Custom title", dueAt: undefined, candidates: [{ source: "caller", assigneeId: "am-2" }] },
    ]);
  });

  it("'content_owners' fires only when asset_inventory names something that does not exist", () => {
    const none = computeDelegationPlan({ asset_inventory: [{ item: "Logo", status: "Exists" }] }, "owner-1", [], NO_POSITIONS);
    expect(none.map((p) => p.role)).toEqual(["discovery_review"]);

    const missing = computeDelegationPlan(
      { asset_inventory: [{ item: "Photos", status: "Does not exist" }] },
      "owner-1",
      [],
      NO_POSITIONS,
    );
    expect(missing.map((p) => p.role).sort()).toEqual(["content_owners", "discovery_review"]);
    // content_owners is an "AM" row (design's OWN default) — its owner candidate is "owner", never
    // "owner_fallback": nothing was tried and failed first.
    expect(missing.find((p) => p.role === "content_owners")?.candidates).toEqual([{ source: "owner", assigneeId: "owner-1" }]);
  });

  it("a caller entry with no role (or an unrecognised one) is additive, never dropped", () => {
    const plan = computeDelegationPlan({}, "owner-1", [
      { role: "translate_content", assigneeId: "am-3", title: "Translate homepage copy" },
      { assigneeId: "am-4", title: "Ad-hoc task with no role at all" },
    ], NO_POSITIONS);
    expect(plan).toContainEqual({
      role: "translate_content", title: "Translate homepage copy", dueAt: undefined,
      candidates: [{ source: "caller", assigneeId: "am-3" }],
    });
    expect(plan.find((p) => p.candidates[0]?.assigneeId === "am-4")).toMatchObject({ title: "Ad-hoc task with no role at all" });
  });

  it("every seeded role in CANONICAL_DELEGATIONS has a non-empty title (a task with no title is a task nobody can read in the queue)", () => {
    for (const [role, spec] of Object.entries(CANONICAL_DELEGATIONS)) {
      expect(spec.title.trim().length, `role '${role}' has an empty title`).toBeGreaterThan(0);
    }
  });
});

describe("AD-6b — agency-delegation-resolver (positions -> a real PM/tech-lead candidate)", () => {
  const PM_SEAT_VACANT: PositionCandidateRow = { positionId: "p-pm", positionTitle: "Project Manager", isLead: false, holderUserId: null };
  const PM_SEAT_FILLED: PositionCandidateRow = { positionId: "p-pm-2", positionTitle: "PM", isLead: false, holderUserId: "pm-user-1" };
  const TECH_LEAD_SEAT: PositionCandidateRow = { positionId: "p-tl", positionTitle: "Tech Lead · Head of Web Dev", isLead: true, holderUserId: "azlan-1" };
  const UNRELATED_SEAT: PositionCandidateRow = { positionId: "p-dev", positionTitle: "Junior Web Developer", isLead: false, holderUserId: "dev-1" };

  it("isPositionResolvableRole recognises exactly the three PM/tech-lead roles, never the two AM roles", () => {
    expect(isPositionResolvableRole("sitemap")).toBe(true);
    expect(isPositionResolvableRole("integrations")).toBe(true);
    expect(isPositionResolvableRole("dns")).toBe(true);
    expect(isPositionResolvableRole("discovery_review")).toBe(false);
    expect(isPositionResolvableRole("content_owners")).toBe(false);
  });

  it("matches a 'Tech Lead' title for integrations/dns and returns its current holder", () => {
    const candidates = [TECH_LEAD_SEAT, UNRELATED_SEAT];
    for (const role of ["integrations", "dns"] as const) {
      expect(pickPositionHolder(role, candidates)).toEqual({
        matchedPositionId: "p-tl", matchedPositionTitle: "Tech Lead · Head of Web Dev", holderUserId: "azlan-1",
      });
    }
  });

  it("matches a 'PM'/'Project Manager' title for sitemap only, never for integrations/dns", () => {
    const candidates = [PM_SEAT_FILLED, UNRELATED_SEAT];
    expect(pickPositionHolder("sitemap", candidates)).toEqual({
      matchedPositionId: "p-pm-2", matchedPositionTitle: "PM", holderUserId: "pm-user-1",
    });
    expect(pickPositionHolder("integrations", candidates).holderUserId).toBeNull();
  });

  it("a title match with a VACANT seat resolves matchedPositionId but a null holder — a materially different case from no match at all", () => {
    const resolution = pickPositionHolder("sitemap", [PM_SEAT_VACANT]);
    expect(resolution.matchedPositionId).toBe("p-pm");
    expect(resolution.holderUserId).toBeNull();
  });

  it("no candidate anywhere carries a matching title -> the empty resolution, not a thrown error or an invented guess", () => {
    expect(pickPositionHolder("sitemap", [UNRELATED_SEAT, TECH_LEAD_SEAT])).toEqual({
      matchedPositionId: null, matchedPositionTitle: null, holderUserId: null,
    });
  });

  it("prefers a FILLED seat over a title-matching VACANT one for the same role", () => {
    const resolution = pickPositionHolder("sitemap", [PM_SEAT_VACANT, PM_SEAT_FILLED]);
    expect(resolution.holderUserId).toBe("pm-user-1");
  });

  it("a title match is decided by regex against free text, so an unconventionally-titled seat (e.g. 'Producer', 'Delivery Lead') never matches — the AD-6b report's flagged, real schema limit, not a bug here", () => {
    const producer: PositionCandidateRow = { positionId: "p-prod", positionTitle: "Producer", isLead: true, holderUserId: "someone" };
    expect(pickPositionHolder("sitemap", [producer]).holderUserId).toBeNull();
    expect(pickPositionHolder("integrations", [producer]).holderUserId).toBeNull();
  });

  it("pickAllPositionHolders resolves all three roles independently from one candidate set", () => {
    const all = pickAllPositionHolders([PM_SEAT_FILLED, TECH_LEAD_SEAT]);
    expect(all.sitemap.holderUserId).toBe("pm-user-1");
    expect(all.integrations.holderUserId).toBe("azlan-1");
    expect(all.dns.holderUserId).toBe("azlan-1");
  });
});

describe("AD-6 — lock namespace hygiene", () => {
  it("AGENCY_LEAD_LOCK_NS is distinct from every other advisory-lock namespace this estate uses", () => {
    // Sibling namespaces, read from their own files at design-review time (design §6.2's own
    // requirement: "a new namespace, NOT PIPELINE_RUN_LOCK_NS"). Hardcoded here rather than imported
    // so this test does not silently stop meaning anything if a sibling constant is ever deleted.
    const OTHERS = [
      0x50520001, // PIPELINE_RUN_LOCK_NS (pipeline-lock.ts)
      0x57430001, // WEBDEV_CR_LOCK_NS (webdev-cr-lock.ts)
      0x41450001, // APPROVAL_EXEC_LOCK_NS (approval-execute.ts)
      0x41535401, // ASSISTANT_THREAD_LOCK_NS
    ];
    expect(OTHERS).not.toContain(AGENCY_LEAD_LOCK_NS);
    expect(AGENCY_LEAD_LOCK_NS).toBe(0x414c0001); // 'AL' + 1 — pinned so an accidental edit is caught
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// §8(b) UPDATE (AD-8, 2026-09-07) — this finding is now PARTIALLY CLOSED, not worked around.
// `agency_intake.convert` is the tool name AD-8 actually shipped (`core/core-tools.ts`), registered
// there with `write:true, impact:"medium"` — which is what makes mcp-hub/src/policy.ts SUSPEND an
// unattended (agent or n8n) call to it before the platform is ever reached
// (mcp-hub/src/agency-intake-tools.test.ts). `core/approval-executables.ts` also now carries a real
// executor entry for it (lockKey + a precondition proven against real Postgres in that file's own
// suite), so a human-approved row for this tool no longer sits at `execution_status='not_applicable'`
// forever the way an unregistered tool does (d14-17-assistant-write-registry.test.ts's (B) suite still
// proves that shape, for a genuinely unregistered tool).
//
// What this does NOT claim: that convert completes unattended end to end. AD-8's brief is explicit
// that this ticket must assert the SUSPENSION, not a pretended completion — a full approve-then-
// executed round trip needs a reachable mcp-hub + Cerbos, out of every D14 registry suite's reach in
// this harness (d14-09-agent-origin-authority.test.ts's own scope note names the identical gap). So
// this suite asserts the registry FACT (an executor exists, under the right name, and no other), not
// an execution outcome.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe("AD-6 / design §8(b) — agency lead convert now HAS a D14 executor entry (AD-8 landed)", () => {
  it("agency_intake.convert is registered; the other plausible names never were", () => {
    expect(getExecutable("agency_intake.convert"), "AD-8 must register the tool name it actually ships").toBeDefined();
    for (const name of ["agency_lead.convert", "agency.lead.convert"]) {
      expect(getExecutable(name), `${name} was never the shipped tool name and must stay unregistered`).toBeUndefined();
    }
  });
});
