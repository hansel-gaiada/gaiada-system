// PV3-02 — the portal's row-visibility predicates (portal-visibility.ts).
//
// THREE PARTS, all static (no DB; the behaviour of every portal query stays pinned by the existing
// portal suites, which PV3-02 does not touch):
//   1. EQUIVALENCE. Each portal call site's predicate BEFORE PV3-02 is copied below verbatim, next to the
//      builder composition that replaced it. The two must have the same set of top-level AND-conjuncts
//      (whitespace-normalised). That is the "same meaning" claim made checkable: reordering a conjunction
//      is harmless, a missing or altered conjunct is a client-data leak or a client losing data.
//   2. BUILDER CONTRACT. Placeholders are the caller's (never assumed), aliases and indexes are validated
//      before they reach SQL text, and NEVER_CLIENT_VISIBLE carries a reason per kind.
//   3. THE GUARD. Every portal-facing production file — any file that imports the portal's scope resolver
//      from portal-scope.ts — must contain none of the old inline row-visibility literals. They live in
//      portal-visibility.ts and nowhere else. The importer set is DISCOVERED, so a portal controller
//      written next month is covered without anyone remembering this ticket.
//   4. PER CLIENT (portal scope kernel, 2026-10-13). The project arm of every predicate is per client
//      (`client in $wide OR project in $projects`), never the flattened `($n IS NULL OR …)`; every scoped
//      builder REQUIRES `wide`; and no portal-facing file may build a scope predicate without it, read the
//      removed global `canSign`, or treat `projectIds === null` as "client-wide".
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  NEVER_CLIENT_VISIBLE, NEVER_CLIENT_VISIBLE_REASONS, PROJECT_SCOPE, scopeAt,
  changeRequestClientVisible, changeRequestInPortalScope, clientContactClientVisible, clientContactInPortalScope,
  contractClientVisible, contractInPortalScope, deliverableClientVisible, gateClientVisible, inCallerClients,
  invoiceClientVisible, invoiceInPortalScope, invoicePaymentClientVisible, invoicePaymentInPortalScope,
  milestoneClientVisible, postReviewClientVisible, postReviewInPortalScope, projectClientVisible,
  projectInPortalScope, projectReach, runClientVisible, runInPortalScope, runStageClientVisible,
  conversationAttachmentClientVisible, conversationMessageClientVisible, conversationThreadClientVisible,
  conversationThreadInPortalScope, staffConversationDraftClientVisible, staffConversationMessageClientVisible,
  staffConversationThreadClientVisible,
  meetingMinutesClientVisible, meetingMinutesInPortalScope, staffMeetingMinutesClientVisible,
  wideClientOnly, wideOrOwnProject,
  clientReportClientVisible, clientReportInPortalScope, staffClientReportClientVisible,
} from "./portal-visibility";

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════════════════════════════

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Top-level AND-conjuncts of a predicate (ANDs inside parentheses stay inside their conjunct). */
function conjuncts(sql: string): string[] {
  const s = norm(sql);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && s.startsWith(" AND ", i)) {
      out.push(s.slice(start, i).trim());
      start = i + 5;
      i += 4;
    }
  }
  out.push(s.slice(start).trim());
  return out.sort();
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Equivalence: old inline predicate (copied from origin/main 39ce3081) vs the builder composition
// ════════════════════════════════════════════════════════════════════════════════════════════════════

// `wide` sits at projects + 1 in these two layouts, which is what lets `perClient` below rewrite an old
// literal mechanically.
const S12 = { clients: 1, projects: 2, wide: 3 };
const S23 = { clients: 2, projects: 3, wide: 4 };
/** PROJECT_SCOPE's composition on the S12 layout (PROJECT_SCOPE itself is `scopeAt(1)`, pinned below). */
const PS12 = projectInPortalScope("p", S12);

/** THE ONE INTENDED CHANGE of the portal scope kernel fix (2026-10-13), applied mechanically to every old
 *  literal: the flattened project arm `($P::uuid[] IS NULL OR <a>.<col> = ANY($P::uuid[])…` becomes the
 *  per-client arm `(<a>.client_id = ANY($(P+1)::uuid[]) OR <a>.<col> = ANY($P::uuid[])…`. Everything else
 *  in every old literal must still be there, conjunct for conjunct. */
function perClient(old: string): string {
  return old.replace(
    /\(\$(\d+)::uuid\[\] IS NULL OR ((?:([a-z_]+)\.)?(?:id|project_id)) = ANY\(\$\1::uuid\[\]\)/g,
    (_m, p: string, column: string, alias: string | undefined) =>
      `(${alias ? `${alias}.` : ""}client_id = ANY($${Number(p) + 1}::uuid[]) OR ${column} = ANY($${p}::uuid[])`,
  );
}

interface Site { site: string; old: string; now: string }

const SITES: Site[] = [
  // ── portal-workspace.controller.ts ──
  { site: "workspace PROJECT_SCOPE (overview, projects, project detail, milestones, timeline, deliverables)",
    old: `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL`,
    now: PS12 },
  { site: "workspace overview next milestone",
    old: `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL AND m.deleted_at IS NULL AND m.status <> 'done' AND m.due_date IS NOT NULL`,
    now: `${PS12} AND ${milestoneClientVisible("m")} AND m.status <> 'done' AND m.due_date IS NOT NULL` },
  { site: "workspace overview deliverable counts / deliverables list",
    old: `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL AND d.deleted_at IS NULL`,
    now: `${PS12} AND ${deliverableClientVisible("d")}` },
  { site: "workspace needsYou gates",
    old: `r.client_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
            AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL
            AND ($2::uuid[] IS NULL OR r.project_id = ANY($2::uuid[]))`,
    now: `${runInPortalScope("r", S12)} AND ${gateClientVisible("g")} AND g.status = 'pending'` },
  // PV3-02d (intentional change, here and in every invoice entry below): an `approved` invoice (the internal
  // maker/checker step before it is sent) is hidden as well as a `draft`. `old` is the NEW literal shape; it
  // was `... AND i.status <> 'draft'`.
  { site: "workspace finance invoices (not draft, not approved — PV3-02d)",
    old: `i.client_id = ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.status NOT IN ('draft','approved') AND (i.status <> 'void' OR i.issued_at IS NOT NULL OR i.pre_pv5_legacy)`,
    now: invoiceInPortalScope("i", { clients: 1 }) },
  { site: "workspace finance payments lateral (detail context)",
    old: `pp.invoice_id = inv.id AND pp.deleted_at IS NULL`,
    now: `pp.invoice_id = inv.id AND ${invoicePaymentClientVisible("pp", "detail")}` },
  { site: "workspace listProjects milestone count",
    old: `m.project_id = p.id AND m.deleted_at IS NULL`,
    now: `m.project_id = p.id AND ${milestoneClientVisible("m")}` },
  { site: "workspace listProjects deliverable count",
    old: `d.project_id = p.id AND d.deleted_at IS NULL`,
    now: `d.project_id = p.id AND ${deliverableClientVisible("d")}` },
  { site: "workspace projectDetail runs",
    old: `r.project_id = $1 AND r.client_id = ANY($2::uuid[]) AND r.deleted_at IS NULL`,
    now: `r.project_id = $1 AND ${inCallerClients("r", 2)} AND ${runClientVisible("r")}` },
  { site: "workspace projectDetail pending client gates",
    old: `g.run_id = r.id AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL`,
    now: `g.run_id = r.id AND ${gateClientVisible("g")} AND g.status = 'pending'` },
  { site: "workspace timeline decisions",
    old: `r.client_id = ANY($1::uuid[]) AND r.deleted_at IS NULL AND g.deleted_at IS NULL
            AND g.actor_side = 'client' AND g.status = 'decided' AND g.decided_at IS NOT NULL
            AND ($2::uuid[] IS NULL OR r.project_id = ANY($2::uuid[]))`,
    now: `${runInPortalScope("r", S12)} AND ${gateClientVisible("g")} AND g.status = 'decided' AND g.decided_at IS NOT NULL` },
  { site: "workspace timeline contracts / commerce listContracts",
    old: `k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status <> 'draft'
            AND ($2::uuid[] IS NULL OR k.project_id = ANY($2::uuid[]) OR k.project_id IS NULL)`,
    now: contractInPortalScope("k", S12) },
  // PV3-02c (intentional change, pinned on purpose): the timeline reaches a payment THROUGH its invoice
  // (`JOIN invoices pi ON pi.id = pp.invoice_id`), so a payment on a deleted or draft invoice is absent.
  // `old` is the NEW literal shape; it was `pp.client_id = ANY($1) AND pp.deleted_at IS NULL AND pp.status = 'confirmed'`.
  { site: "workspace timeline payments (timeline context, through a visible invoice — PV3-02c)",
    old: `pp.deleted_at IS NULL AND pp.status = 'confirmed' AND pi.client_id = ANY($1::uuid[]) AND pi.deleted_at IS NULL AND pi.status NOT IN ('draft','approved') AND (pi.status <> 'void' OR pi.issued_at IS NOT NULL OR pi.pre_pv5_legacy)`,
    now: `${invoicePaymentClientVisible("pp", "timeline")} AND ${invoiceInPortalScope("pi", { clients: 1 })}` },

  // ── portal.controller.ts ──
  { site: "portal listRuns",
    old: `client_id = ANY($1::uuid[]) AND deleted_at IS NULL
           AND ($2::uuid[] IS NULL OR project_id = ANY($2::uuid[]))`,
    now: runInPortalScope("", S12) },
  { site: "portal listRuns stages / getRun stages",
    old: `run_id = $1 AND track <> 'report'`,
    now: `run_id = $1 AND ${runStageClientVisible("")}` },
  { site: "portal listRuns gates / getRun gates",
    old: `run_id = ANY($1::uuid[]) AND actor_side = 'client' AND deleted_at IS NULL`,
    now: `run_id = ANY($1::uuid[]) AND ${gateClientVisible("")}` },
  { site: "portal getRun / scopeSign run",
    old: `id = $1 AND client_id = ANY($2::uuid[]) AND deleted_at IS NULL
            AND ($3::uuid[] IS NULL OR project_id = ANY($3::uuid[]))`,
    now: `id = $1 AND ${runInPortalScope("", S23)}` },
  { site: "portal decideGate ownership read",
    old: `g.id = $1 AND r.client_id = ANY($2::uuid[]) AND g.actor_side = 'client' AND g.deleted_at IS NULL
           AND r.deleted_at IS NULL
           AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]))`,
    now: `g.id = $1 AND ${runInPortalScope("r", S23)} AND ${gateClientVisible("g")}` },
  // PV3-02c (intentional change): the scope-sign completion UPDATE may only decide a CLIENT-side gate.
  // `old` is the NEW literal shape; before it had `deleted_at IS NULL` and no `actor_side` or `kind` conjunct.
  { site: "portal scopeSign completion UPDATE (client-side gate only — PV3-02c)",
    old: `id = $1 AND run_id = $3 AND status = 'pending' AND kind = 'scope_signoff' AND actor_side = 'client' AND deleted_at IS NULL`,
    now: `id = $1 AND run_id = $3 AND status = 'pending' AND kind = 'scope_signoff' AND ${gateClientVisible("")}` },
  { site: "portal decideGate guarded UPDATE",
    old: `g.id = $1 AND g.run_id = r.id AND r.client_id = ANY($5::uuid[])
           AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL`,
    now: `g.id = $1 AND g.run_id = r.id AND ${inCallerClients("r", 5)} AND ${gateClientVisible("g")} AND g.status = 'pending'` },

  // ── portal-commerce.controller.ts ──
  { site: "commerce listInvoices payments lateral (detail context)",
    old: `pp.invoice_id = i.id AND pp.deleted_at IS NULL`,
    now: `pp.invoice_id = i.id AND ${invoicePaymentClientVisible("pp", "detail")}` },
  { site: "commerce invoiceDetail payments (detail context)",
    old: `pp.invoice_id = $1 AND pp.deleted_at IS NULL`,
    now: `pp.invoice_id = $1 AND ${invoicePaymentClientVisible("pp", "detail")}` },
  { site: "commerce ownedInvoice",
    old: `i.id = $1 AND i.client_id = ANY($2::uuid[]) AND i.deleted_at IS NULL AND i.status NOT IN ('draft','approved') AND (i.status <> 'void' OR i.issued_at IS NOT NULL OR i.pre_pv5_legacy)`,
    now: `i.id = $1 AND ${invoiceInPortalScope("i", { clients: 2 })}` },
  { site: "commerce ownedContract / ownsEntity.contract",
    old: `k.id = $1 AND k.client_id = ANY($2::uuid[]) AND k.deleted_at IS NULL AND k.status <> 'draft'
          AND ($3::uuid[] IS NULL OR k.project_id = ANY($3::uuid[]) OR k.project_id IS NULL)`,
    now: `k.id = $1 AND ${contractInPortalScope("k", S23)}` },
  // PV3-02c (intentional change): the deliverable's project must itself be visible (`p.deleted_at IS NULL`),
  // like every deliverable list. `old` is the NEW literal shape.
  { site: "commerce ownsEntity.deliverable (project not deleted — PV3-02c)",
    old: `d.id = $1 AND d.deleted_at IS NULL
                       AND p.client_id = ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[])) AND p.deleted_at IS NULL`,
    now: `d.id = $1 AND ${deliverableClientVisible("d")} AND ${projectInPortalScope("p", S23)}` },
  { site: "commerce ownsEntity.project",
    old: `p.id = $1 AND p.deleted_at IS NULL
                  AND p.client_id = ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))`,
    now: `p.id = $1 AND ${projectInPortalScope("p", S23)}` },
  // PV3-02c (intentional change): the receipt is reached THROUGH its invoice (`JOIN invoices i ON i.id =
  // pp.invoice_id`), so a payment on a deleted or draft invoice has no receipt. `old` is the NEW literal shape.
  { site: "commerce ownsEntity.invoice_payment (receipt download, through a visible invoice — PV3-02c)",
    old: `pp.id = $1 AND pp.deleted_at IS NULL
                          AND i.client_id = ANY($2::uuid[]) AND i.deleted_at IS NULL AND i.status NOT IN ('draft','approved') AND (i.status <> 'void' OR i.issued_at IS NOT NULL OR i.pre_pv5_legacy)`,
    now: `pp.id = $1 AND ${invoicePaymentClientVisible("pp", "detail")} AND ${invoiceInPortalScope("i", { clients: 2 })}` },

  // ── mail/thread.controller.ts (MAIL-33 portal mail threads, PV3-02b) ──
  { site: "portal mail thread ?gateId= ownership read (unchanged meaning)",
    old: `g.id = $1 AND g.deleted_at IS NULL AND g.actor_side = 'client' AND r.deleted_at IS NULL
              AND r.client_id = ANY($2::uuid[])
              AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]))`,
    now: `g.id = $1 AND ${runInPortalScope("r", S23)} AND ${gateClientVisible("g")}` },
  // PV3-02b (intentional change): the run branch no longer admits a project-less run to a project-scoped
  // contact. `old` is the NEW literal shape; before it ended `... OR r.project_id IS NULL)`.
  { site: "portal mail thread ?runId= ownership read (no NULL-project admission — PV3-02b)",
    old: `r.id = $1 AND r.deleted_at IS NULL AND r.client_id = ANY($2::uuid[])
            AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]))`,
    now: `r.id = $1 AND ${runInPortalScope("r", S23)}` },

  // ── webdev-change-requests-portal.controller.ts ──
  { site: "change requests list",
    old: `wcr.client_id = ANY($1::uuid[])
            AND ($2::uuid[] IS NULL OR wcr.project_id = ANY($2::uuid[]) OR wcr.project_id IS NULL)
            AND wcr.deleted_at IS NULL`,
    now: changeRequestInPortalScope("wcr", S12) },
  { site: "change requests owned",
    old: `wcr.id = $1 AND wcr.client_id = ANY($2::uuid[])
          AND ($3::uuid[] IS NULL OR wcr.project_id = ANY($3::uuid[]) OR wcr.project_id IS NULL)
          AND wcr.deleted_at IS NULL`,
    now: `wcr.id = $1 AND ${changeRequestInPortalScope("wcr", S23)}` },

  // ── social-client-review-portal.controller.ts ──
  { site: "post reviews list",
    old: `r.client_id = ANY($1::uuid[])`,
    now: postReviewInPortalScope("r", { clients: 1 }) },
  { site: "post reviews decide ownership read",
    old: `r.id = $1 AND r.client_id = ANY($2::uuid[])`,
    now: `r.id = $1 AND ${postReviewInPortalScope("r", { clients: 2 })}` },
  { site: "post reviews guarded UPDATE",
    old: `id = $1 AND client_id = ANY($6::uuid[]) AND status = 'pending'`,
    now: `id = $1 AND ${postReviewInPortalScope("", { clients: 6 })} AND status = 'pending'` },

  // portal-profile.controller.ts (the People area, PV2-07) is NOT in this table any more: PV-D36 (2026-10-13)
  // changed its meaning on purpose, so it has its own tests below ("PV4-13 People list").
];

describe("PV3-02 equivalence — every switched call site keeps its exact conjunct set", () => {
  it.each(SITES)("$site", ({ old, now }) => {
    expect(conjuncts(now)).toEqual(conjuncts(perClient(old)));
  });

  it("perClient really rewrites: every SITES literal that had the flattened arm loses it", () => {
    for (const { old } of SITES) expect(perClient(old)).not.toMatch(/::uuid\[\] IS NULL OR/);
    expect(SITES.filter(({ old }) => /::uuid\[\] IS NULL OR/.test(old)).length).toBeGreaterThan(15);
  });

  it("PROJECT_SCOPE is the old module-private constant with ONLY the project arm made per client (scopeAt(1))", () => {
    expect(PROJECT_SCOPE).toBe(
      `p.client_id = ANY($1::uuid[]) AND (p.client_id = ANY($2::uuid[]) OR p.id = ANY($3::uuid[])) AND p.deleted_at IS NULL`,
    );
  });

  it("PV3-02b: the mail thread run branch differs from its old shape in exactly one conjunct (the NULL-project arm)", () => {
    const old = perClient(`r.id = $1 AND r.deleted_at IS NULL AND r.client_id = ANY($2::uuid[])
            AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]) OR r.project_id IS NULL)`);
    const now = `r.id = $1 AND ${runInPortalScope("r", S23)}`;
    expect(conjuncts(old).filter((c) => !conjuncts(now).includes(c))).toEqual([
      `(r.client_id = ANY($4::uuid[]) OR r.project_id = ANY($3::uuid[]) OR r.project_id IS NULL)`,
    ]);
    expect(conjuncts(now).filter((c) => !conjuncts(old).includes(c))).toEqual([
      `(r.client_id = ANY($4::uuid[]) OR r.project_id = ANY($3::uuid[]))`,
    ]);
  });

  it("PV3-02c: the scope-sign completion UPDATE gained exactly two conjuncts, the scope_signoff kind and the client-side gate", () => {
    const old = `id = $1 AND run_id = $3 AND status = 'pending' AND deleted_at IS NULL`;
    const now = `id = $1 AND run_id = $3 AND status = 'pending' AND kind = 'scope_signoff' AND ${gateClientVisible("")}`;
    expect(conjuncts(old).filter((c) => !conjuncts(now).includes(c))).toEqual([]);
    expect(conjuncts(now).filter((c) => !conjuncts(old).includes(c))).toEqual([`actor_side = 'client'`, `kind = 'scope_signoff'`]);
  });

  it("needsYou contracts: the ONLY added conjunct is `status <> 'draft'`, implied by `status = 'sent'`", () => {
    const old = perClient(`k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status = 'sent'
            AND ($2::uuid[] IS NULL OR k.project_id = ANY($2::uuid[]) OR k.project_id IS NULL)`);
    const now = `${contractInPortalScope("k", S12)} AND k.status = 'sent'`;
    const added = conjuncts(now).filter((c) => !conjuncts(old).includes(c));
    const dropped = conjuncts(old).filter((c) => !conjuncts(now).includes(c));
    expect(dropped).toEqual([]);
    expect(added).toEqual([`k.status <> 'draft'`]);
  });

  it("the conjunct splitter keeps a parenthesised OR whole (so a dropped NULL arm cannot hide)", () => {
    expect(conjuncts(`a = 1 AND ($2::uuid[] IS NULL OR x = ANY($2::uuid[]) OR x IS NULL)`)).toEqual(
      [`($2::uuid[] IS NULL OR x = ANY($2::uuid[]) OR x IS NULL)`, `a = 1`],
    );
    // And a narrower OR is a DIFFERENT conjunct, which is the whole point.
    expect(conjuncts(contractInPortalScope("k", S12))).not.toEqual(conjuncts(runInPortalScope("k", S12)));
  });
});

describe("PV4-13 People list (owner ruling PV-D36) — clientContactInPortalScope", () => {
  const people = clientContactInPortalScope("cc", scopeAt(1));

  it("is the old People predicate PLUS exactly one conjunct: the per-client project arm that admits project-less contacts", () => {
    const old = `cc.client_id = ANY($1::uuid[]) AND cc.deleted_at IS NULL AND cc.status <> 'revoked'`;
    expect(conjuncts(old).filter((c) => !conjuncts(people).includes(c))).toEqual([]);
    expect(conjuncts(people).filter((c) => !conjuncts(old).includes(c))).toEqual([
      `(cc.client_id = ANY($2::uuid[]) OR cc.project_id = ANY($3::uuid[]) OR cc.project_id IS NULL)`,
    ]);
  });

  it("binds the three scope arrays at whatever index the caller names, and refuses a params object without `wide`", () => {
    expect(clientContactInPortalScope("c", { clients: 4, wide: 5, projects: 6 })).toContain(
      `(c.client_id = ANY($5::uuid[]) OR c.project_id = ANY($6::uuid[]) OR c.project_id IS NULL)`,
    );
    expect(() => clientContactInPortalScope("cc", { clients: 1, projects: 2 } as never)).toThrow(/invalid parameter index/);
  });

  it("the profile controller feeds it the whole scope (scopeAt + scopeValues), not just the client ids", () => {
    const src = codeOnly(readFileSync(join(SRC, "core/portal-profile.controller.ts"), "utf8"));
    expect(src).toContain(`clientContactInPortalScope("cc", scopeAt(1))`);
    expect(src).not.toMatch(/clientContactInPortalScope\("cc", \{/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Builder contract
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe("PV3-02 builder contract", () => {
  it("binds whatever indexes the caller names, never a fixed $1/$2", () => {
    expect(contractInPortalScope("k", { clients: 7, wide: 8, projects: 9 })).toBe(
      `k.client_id = ANY($7::uuid[]) AND k.deleted_at IS NULL AND k.status <> 'draft' AND (k.client_id = ANY($8::uuid[]) OR k.project_id = ANY($9::uuid[]) OR k.project_id IS NULL)`,
    );
    expect(scopeAt(2)).toEqual({ clients: 2, wide: 3, projects: 4 });
    expect(invoiceInPortalScope("x", { clients: 4 })).toBe(`x.client_id = ANY($4::uuid[]) AND x.deleted_at IS NULL AND x.status NOT IN ('draft','approved') AND (x.status <> 'void' OR x.issued_at IS NOT NULL OR x.pre_pv5_legacy)`);
  });

  it("row-state builders bind NO parameters (so the staff side can reuse them, PV3-07)", () => {
    const rowState = [
      projectClientVisible("t"), milestoneClientVisible("t"), deliverableClientVisible("t"), runClientVisible("t"),
      runStageClientVisible("t"), gateClientVisible("t"), contractClientVisible("t"), invoiceClientVisible("t"),
      invoicePaymentClientVisible("t", "detail"), invoicePaymentClientVisible("t", "timeline"),
      changeRequestClientVisible("t"), postReviewClientVisible("t"), clientContactClientVisible("t"),
    ];
    for (const sql of rowState) expect(sql).not.toMatch(/\$\d/);
  });

  it("encodes the hidden report stage, client-side gates, non-draft contracts, invoices not draft/approved, and the two payment contexts", () => {
    expect(runStageClientVisible("s")).toBe(`s.track <> 'report'`);
    expect(gateClientVisible("g")).toBe(`g.actor_side = 'client' AND g.deleted_at IS NULL`);
    expect(contractClientVisible("k")).toBe(`k.deleted_at IS NULL AND k.status <> 'draft'`);
    expect(invoiceClientVisible("i")).toBe(`i.deleted_at IS NULL AND i.status NOT IN ('draft','approved') AND (i.status <> 'void' OR i.issued_at IS NOT NULL OR i.pre_pv5_legacy)`);
    expect(invoicePaymentClientVisible("pp", "detail")).toBe(`pp.deleted_at IS NULL`);
    expect(invoicePaymentClientVisible("pp", "timeline")).toBe(`pp.deleted_at IS NULL AND pp.status = 'confirmed'`);
    expect(postReviewClientVisible("r")).toBe(`TRUE`);
    expect(clientContactClientVisible("cc")).toBe(`cc.deleted_at IS NULL AND cc.status <> 'revoked'`);
  });

  it("project NULL handling: runs do not admit a project-less row for a project-scoped contact; contracts and change requests do", () => {
    expect(runInPortalScope("r", S12)).not.toContain("project_id IS NULL");
    expect(contractInPortalScope("k", S12)).toContain(`OR k.project_id IS NULL)`);
    expect(changeRequestInPortalScope("w", S12)).toContain(`OR w.project_id IS NULL)`);
    // projectReach is layer 3 only: no row-state (projectInPortalScope = projectReach + projectClientVisible).
    expect(projectReach("p", S12)).not.toContain("deleted_at");
  });

  it("refuses an alias or a parameter index that is not a plain identifier / positive integer", () => {
    expect(() => contractClientVisible("k; DROP TABLE x")).toThrow(/invalid table alias/);
    expect(() => gateClientVisible("G")).toThrow(/invalid table alias/);
    expect(() => postReviewClientVisible("1x")).toThrow(/invalid table alias/);
    expect(() => inCallerClients("k", 0)).toThrow(/invalid parameter index/);
    expect(() => inCallerClients("k", 1.5)).toThrow(/invalid parameter index/);
    expect(() => runInPortalScope("r", { clients: 1, wide: 3, projects: -2 })).toThrow(/invalid parameter index/);
    expect(() => runInPortalScope("r", { clients: 1, wide: 0, projects: 2 })).toThrow(/invalid parameter index/);
    expect(() => invoicePaymentClientVisible("pp", "ledger" as never)).toThrow(/unknown invoice payment context/);
  });

  it("invoicePaymentInPortalScope is the direct-reach (own client_id) shape; the portal no longer uses it (PV3-02c)", () => {
    expect(invoicePaymentInPortalScope("pp", "timeline", { clients: 1 })).toBe(
      `pp.client_id = ANY($1::uuid[]) AND pp.deleted_at IS NULL AND pp.status = 'confirmed'`,
    );
  });

  it("an empty alias means unqualified columns", () => {
    expect(gateClientVisible("")).toBe(`actor_side = 'client' AND deleted_at IS NULL`);
  });

  it("NEVER_CLIENT_VISIBLE is exactly task, meeting, note, history — each with a reason", () => {
    expect([...NEVER_CLIENT_VISIBLE]).toEqual(["task", "meeting", "note", "history"]);
    expect(Object.keys(NEVER_CLIENT_VISIBLE_REASONS).sort()).toEqual([...NEVER_CLIENT_VISIBLE].sort());
    for (const k of NEVER_CLIENT_VISIBLE) expect(NEVER_CLIENT_VISIBLE_REASONS[k].length).toBeGreaterThan(40);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2b. PV4-03 — conversation predicates
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe("PV4-03 conversation predicates", () => {
  it("a thread is reached by client AND project, with NO client-wide-thread admission for a project-scoped contact (PV4-Q1)", () => {
    expect(conversationThreadInPortalScope("t", S23)).toBe(
      `t.client_id = ANY($2::uuid[]) AND t.deleted_at IS NULL AND (t.client_id = ANY($4::uuid[]) OR t.project_id = ANY($3::uuid[]))`,
    );
    // The contract/change-request shape admits project_id IS NULL; the thread shape must not.
    expect(conversationThreadInPortalScope("t", S12)).not.toContain("project_id IS NULL");
    expect(conjuncts(conversationThreadInPortalScope("t", S12))).toEqual(conjuncts(runInPortalScope("t", S12)));
  });

  it("row-state halves bind no parameters; attachments are withdrawn with a retracted message", () => {
    for (const sql of [conversationThreadClientVisible("t"), conversationMessageClientVisible("m"), conversationAttachmentClientVisible("m")]) {
      expect(sql).not.toMatch(/\$\d/);
    }
    expect(conversationMessageClientVisible("m")).toBe("TRUE");
    expect(conversationAttachmentClientVisible("m")).toBe("m.retracted_at IS NULL");
  });

  it("staff flags: threads and messages through the thread's client; drafts are the constant FALSE", () => {
    expect(staffConversationThreadClientVisible("t")).toBe("(t.client_id IS NOT NULL AND (t.deleted_at IS NULL))");
    expect(staffConversationMessageClientVisible("m", "t")).toBe("(t.client_id IS NOT NULL AND (t.deleted_at IS NULL) AND (TRUE))");
    expect(staffConversationDraftClientVisible("d")).toBe("FALSE");
    expect(() => staffConversationDraftClientVisible("d;x")).toThrow(/invalid table alias/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2c. PV4-05 — meeting minutes predicates
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe("PV4-05 meeting minutes predicates", () => {
  it("minutes are reached by the MEETING's client and project (decision 8: no copy), only once shared, with NO project-less admission (PV4-Q1)", () => {
    expect(meetingMinutesInPortalScope("mm", "m", S12)).toBe(
      `m.client_id = ANY($1::uuid[]) AND mm.status = 'shared' AND m.deleted_at IS NULL AND (m.client_id = ANY($3::uuid[]) OR m.project_id = ANY($2::uuid[]))`,
    );
    // The contract/change-request shape admits project_id IS NULL; the minutes shape must not (same as runs and threads).
    expect(meetingMinutesInPortalScope("mm", "m", S12)).not.toContain("project_id IS NULL");
    expect(conjuncts(meetingMinutesInPortalScope("mm", "m", S12)).filter((c) => c.includes("project_id"))).toEqual(
      conjuncts(runInPortalScope("m", S12)).filter((c) => c.includes("project_id")),
    );
  });

  it("binds whatever indexes the caller names, and the row-state half binds none (so the staff side can reuse it)", () => {
    expect(meetingMinutesInPortalScope("a", "b", S23)).toContain("b.client_id = ANY($2::uuid[])");
    expect(meetingMinutesInPortalScope("a", "b", S23)).toContain("(b.client_id = ANY($4::uuid[]) OR b.project_id = ANY($3::uuid[]))");
    expect(meetingMinutesClientVisible("mm", "m")).not.toMatch(/\$\d/);
    expect(meetingMinutesClientVisible("mm", "m")).toBe(`mm.status = 'shared' AND m.deleted_at IS NULL`);
  });

  it("a draft is never visible: the row-state half names `shared`, and `meeting` stays in NEVER_CLIENT_VISIBLE", () => {
    expect(meetingMinutesClientVisible("mm", "m")).toContain(`mm.status = 'shared'`);
    expect([...NEVER_CLIENT_VISIBLE]).toContain("meeting");
  });

  it("staff flag: the meeting has a client AND the minutes are shared on a live meeting", () => {
    expect(staffMeetingMinutesClientVisible("mm", "m")).toBe("(m.client_id IS NOT NULL AND (mm.status = 'shared' AND m.deleted_at IS NULL))");
  });

  it("refuses an alias that is not a plain identifier", () => {
    expect(() => meetingMinutesClientVisible("mm; DROP TABLE x", "m")).toThrow(/invalid table alias/);
    expect(() => meetingMinutesInPortalScope("mm", "M", S12)).toThrow(/invalid table alias/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. The guard: no inline row-visibility literal in any portal-facing production file
// ════════════════════════════════════════════════════════════════════════════════════════════════════

const NEST_ROOT = join(__dirname, "..", "..");
const SRC = join(NEST_ROOT, "src");
const rel = (abs: string) => relative(NEST_ROOT, abs).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** A file is portal-facing when it imports the portal's caller resolver or its signing gate. */
const PORTAL_SCOPE_IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']*\/portal-scope["']/g;
const RESOLVER_NAMES = ["resolvePortalScope", "callerClientIds", "requireSignerFor", "canSignFor", "scopeValues"];

function importsPortalScope(src: string): boolean {
  for (const m of src.matchAll(PORTAL_SCOPE_IMPORT)) {
    const names = m[1].split(",").map((n) => n.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim());
    if (names.some((n) => RESOLVER_NAMES.includes(n))) return true;
  }
  return false;
}

/** The old inline literals. Each one now has exactly one home in portal-visibility.ts. */
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "draft exclusion (contracts)", re: /status\s*<>\s*'draft'/ },
  // PV3-02d: invoices are hidden while `draft` OR `approved`, written as a NOT IN list.
  { name: "unissued-invoice exclusion (invoices)", re: /status\s+NOT\s+IN\s*\(\s*'draft'/ },
  { name: "client-side gate", re: /actor_side\s*=\s*'client'/ },
  { name: "hidden report stage", re: /track\s*<>\s*'report'/ },
  { name: "revoked-contact exclusion", re: /status\s*<>\s*'revoked'/ },
  // The per-client project arm — the body of PROJECT_SCOPE and every run/contract/request copy of it.
  { name: "project-scope `client_id = ANY($n::uuid[]) OR`", re: /client_id\s*=\s*ANY\(\$\d+::uuid\[\]\)\s+OR/ },
  // PV7-04a: a client report is visible once published; the literal belongs to clientReportClientVisible alone.
  { name: "published client report (client reports)", re: /status\s*=\s*'published'/ },
];

/** Comment lines are prose, not SQL (SQL comments inside template strings are `--`, which stay scanned). */
function codeOnly(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");
}

function hits(abs: string): string[] {
  const code = codeOnly(readFileSync(abs, "utf8"));
  return FORBIDDEN.filter((f) => f.re.test(code)).map((f) => f.name);
}

/** Portal-facing files OUTSIDE PV3-02's owned paths that still carry an inline literal. A RATCHET, not an
 *  exemption: the test below fails if an entry stops importing portal-scope or stops containing a literal,
 *  so an entry cannot outlive its refactor. Never add a file here to make the guard pass — switch it to
 *  portal-visibility.ts instead. */
const NOT_YET_SWITCHED: Record<string, string> = {};

/** The portal controllers PV3-02 switched. The scan must find every one, or it is broken. */
const SWITCHED = [
  "src/core/portal-workspace.controller.ts",
  "src/core/portal-commerce.controller.ts",
  "src/core/portal.controller.ts",
  "src/core/webdev-change-requests-portal.controller.ts",
  "src/core/social-client-review-portal.controller.ts",
  "src/core/portal-profile.controller.ts",
  // PV4-03: written on the builders from day one; listed so the importer scan must find it.
  "src/core/portal-conversation.controller.ts",
  // PV5-08: the Documents list, written on the builders from day one.
  "src/core/portal-documents.controller.ts",
  // PV6-02: Services & results; its client-wide test is the per-client scope's `wideClientIds`.
  "src/core/portal-centre-results.controller.ts",
  // PV7-02: client health for the portal, written on the builders from day one (its reads are client-health.ts and client-ball.ts).
  "src/core/portal-health.controller.ts",
  // PV7-04a: the client's Reports list and read marker, written on the builders from day one (clientReportInPortalScope).
  "src/core/portal-reports.controller.ts",
  // PV7-07: the account summary's snapshot reads through a synthetic client-wide scope, written on the builders from day one.
  "src/modules/clients/account-summary/snapshot.ts",
  // PV5-11: the certified-signing start route and the simulated PSrE's portal pages, written on the builders from day one.
  "src/signatures/certified-signing.controller.ts",
  "src/signatures/simulated-psre.controller.ts",
];

describe("PV3-02 guard — portal-facing files carry no inline row-visibility literal", () => {
  const files = walk(SRC).filter((f) => !f.endsWith(`${sep}portal-visibility.ts`));
  const importers = files.filter((f) => importsPortalScope(readFileSync(f, "utf8"))).map(rel).sort();

  it("the importer scan is not vacuous: it finds every switched portal controller", () => {
    expect(importers.length).toBeGreaterThan(0);
    for (const f of SWITCHED) expect(importers).toContain(f);
  });

  it("the forbidden patterns are live: each matches the predicate that now owns it", () => {
    const own = [
      contractClientVisible("k"), invoiceClientVisible("i"), gateClientVisible("g"), runStageClientVisible("s"),
      clientContactClientVisible("cc"), PROJECT_SCOPE, clientReportClientVisible("cr"),
    ].join("\n");
    for (const f of FORBIDDEN) expect(own).toMatch(f.re);
  });

  it("no portal-facing file (other than the ratchet list) contains an old literal", () => {
    const offenders = importers
      .filter((f) => !(f in NOT_YET_SWITCHED))
      .map((f) => ({ file: f, literals: hits(join(NEST_ROOT, f)) }))
      .filter((o) => o.literals.length > 0);
    expect(offenders).toEqual([]);
  });

  it("the ratchet list holds only files that are still portal-facing AND still carry a literal", () => {
    for (const f of Object.keys(NOT_YET_SWITCHED)) {
      expect(importers, `${f} no longer imports portal-scope; remove it from NOT_YET_SWITCHED`).toContain(f);
      expect(hits(join(NEST_ROOT, f)), `${f} carries no literal any more; remove it from NOT_YET_SWITCHED`).not.toEqual([]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. Per client (portal scope kernel, 2026-10-13)
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// The flaw this closes: a contact who was client-wide on client A and limited to one project on client B
// saw every project of B (the old `($n IS NULL OR …)` arm was fed a NULL as soon as ANY row was client-wide),
// and a signer on A could sign B's agreements (one global `canSign`). The HTTP proof is
// `portal-scope-per-client.db.test.ts`; these are the static halves that run on every machine.

describe("portal scope per client — the predicates", () => {
  const scoped = [
    ["project", projectInPortalScope("x", scopeAt(1))],
    ["projectReach", projectReach("x", scopeAt(1))],
    ["run", runInPortalScope("x", scopeAt(1))],
    ["contract", contractInPortalScope("x", scopeAt(1))],
    ["change request", changeRequestInPortalScope("x", scopeAt(1))],
    ["conversation thread", conversationThreadInPortalScope("x", scopeAt(1))],
    ["meeting minutes", meetingMinutesInPortalScope("mm", "x", scopeAt(1))],
  ] as const;

  it.each(scoped)("%s: the project arm is per client (the row's own client in $wide) and AND-ed with the caller's clients", (_n, sql) => {
    expect(sql).toContain("x.client_id = ANY($1::uuid[])");
    expect(sql).toMatch(/\(x\.client_id = ANY\(\$2::uuid\[\]\) OR x\.(?:id|project_id) = ANY\(\$3::uuid\[\]\)/);
    expect(sql).not.toMatch(/::uuid\[\]\s+IS\s+NULL/);
  });

  it("allowNullProject is unchanged: contracts and change requests admit a project-less row, runs, threads, minutes and projects do not", () => {
    const admits = Object.fromEntries(scoped.map(([n, sql]) => [n, /project_id IS NULL\)/.test(sql)]));
    expect(admits).toEqual({
      project: false, projectReach: false, run: false, contract: true, "change request": true,
      "conversation thread": false, "meeting minutes": false,
    });
  });

  it("every scoped builder refuses a params object without `wide` (it cannot tell which clients are client-wide)", () => {
    const noWide = { clients: 1, projects: 2 } as never;
    expect(() => projectInPortalScope("p", noWide)).toThrow(/invalid parameter index/);
    expect(() => runInPortalScope("r", noWide)).toThrow(/invalid parameter index/);
    expect(() => contractInPortalScope("k", noWide)).toThrow(/invalid parameter index/);
    expect(() => changeRequestInPortalScope("w", noWide)).toThrow(/invalid parameter index/);
    expect(() => conversationThreadInPortalScope("t", noWide)).toThrow(/invalid parameter index/);
    expect(() => meetingMinutesInPortalScope("mm", "m", noWide)).toThrow(/invalid parameter index/);
  });
});

describe("portal scope per client — the guard over every portal-facing file", () => {
  const files = walk(SRC).filter((f) => !f.endsWith(`${sep}portal-visibility.ts`) && !f.endsWith(`${sep}portal-scope.ts`));
  const importers = files.filter((f) => importsPortalScope(readFileSync(f, "utf8")));

  /** The shapes the flattened kernel used. Each is a way to build or read scope WITHOUT the per-client
   *  split, so none may appear in the code of any portal-facing file. */
  const DEAD: Array<{ name: string; re: RegExp }> = [
    // A scope-params literal with no `wide` (`{ clients: 2, projects: 3 }`): the builders would throw at
    // runtime, but a literal typed loosely enough to dodge tsc must still fail here.
    { name: "scope params without `wide`", re: /\{\s*clients:\s*\d+\s*,\s*projects:\s*\d+\s*\}/ },
    { name: "flattened `projectIds === null` / `!== null`", re: /projectIds\s*[!=]==?\s*null/ },
    { name: "the removed global `.canSign` scope flag", re: /scope\.canSign\b/ },
    { name: "the removed `requireSigner(scope)`", re: /\brequireSigner\s*\(/ },
    { name: "the flattened project arm `$n::uuid[] IS NULL OR`", re: /\$\d+::uuid\[\]\s+IS\s+NULL\s+OR/ },
  ];

  it("the scan is not vacuous: every switched portal controller is found", () => {
    for (const f of SWITCHED) expect(importers.map(rel)).toContain(f);
  });

  it("the dead shapes are live detectors", () => {
    expect(`x({ clients: 2, projects: 3 })`).toMatch(DEAD[0].re);
    expect(`canUseGeneral: scope.projectIds === null`).toMatch(DEAD[1].re);
    expect(`viewOnly: !scope.canSign`).toMatch(DEAD[2].re);
    expect(`requireSigner(scope);`).toMatch(DEAD[3].re);
    expect(`($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))`).toMatch(DEAD[4].re);
    expect(`requireSignerFor(scope, k.clientId);`).not.toMatch(DEAD[3].re);
  });

  it("no portal-facing file builds a scope predicate without `wide`, reads a flattened flag, or uses the old signing gate", () => {
    const offenders = importers
      .map((f) => ({ file: rel(f), shapes: DEAD.filter((d) => d.re.test(codeOnly(readFileSync(f, "utf8")))).map((d) => d.name) }))
      .filter((o) => o.shapes.length > 0);
    expect(offenders).toEqual([]);
  });

  it("portal-visibility.ts itself no longer carries the flattened arm", () => {
    expect(codeOnly(readFileSync(join(SRC, "core", "portal-visibility.ts"), "utf8"))).not.toMatch(DEAD[4].re);
  });

  it("PV7-02: the health controller is discovered as portal-facing and is on the SWITCHED list", () => {
    expect(importers.map(rel)).toContain("src/core/portal-health.controller.ts");
    expect(SWITCHED).toContain("src/core/portal-health.controller.ts");
  });

  it("a file that lays scope params out with scopeAt(n) binds them with scopeValues(scope)", () => {
    const offenders = importers
      .filter((f) => { const code = codeOnly(readFileSync(f, "utf8")); return /\bscopeAt\(/.test(code) && !/\bscopeValues\(/.test(code); })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. Client health (PV7-02, BFF 54.5): client-wide material reaches client-wide contacts only
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// The health read takes the STRICT reading of PV-D33 and PV-D37: a row with no project is told only to a contact who reaches
// the client client-wide, unlike contracts and change requests in the portal lists (which admit a project-less row to a
// project-scoped contact). Two reach builders carry it. The HTTP proof is portal-health.db.test.ts.

describe("PV7-02 · the health reach builders", () => {
  const S = scopeAt(2);

  it("wideClientOnly: the row's client is one the caller reaches client-wide, and nothing else", () => {
    expect(wideClientOnly("pp", S)).toBe("pp.client_id = ANY($3::uuid[])");
    expect(wideClientOnly("pp", S)).not.toContain("$4");
    expect(wideClientOnly("", scopeAt(1))).toBe("client_id = ANY($2::uuid[])");
  });

  it("wideOrOwnProject: client-wide OR one of the caller's own projects, with NO null-project arm", () => {
    expect(wideOrOwnProject("w", S)).toBe("(w.client_id = ANY($3::uuid[]) OR w.project_id = ANY($4::uuid[]))");
    expect(wideOrOwnProject("w", S)).not.toMatch(/IS NULL/);
  });

  it("the difference from the portal lists is the point: contracts and change requests admit a project-less row, this does not", () => {
    expect(contractInPortalScope("k", S)).toMatch(/k\.project_id IS NULL\)/);
    expect(changeRequestInPortalScope("w", S)).toMatch(/w\.project_id IS NULL\)/);
    expect(wideOrOwnProject("k", S)).not.toMatch(/project_id IS NULL/);
  });

  it("refuse an alias that is not a plain identifier, and a params object without `wide`", () => {
    expect(() => wideClientOnly("pp; DROP TABLE x", S)).toThrow(/invalid table alias/);
    expect(() => wideOrOwnProject("W", S)).toThrow(/invalid table alias/);
    const noWide = { clients: 1, projects: 2 } as never;
    expect(() => wideClientOnly("pp", noWide)).toThrow(/invalid parameter index/);
    expect(() => wideOrOwnProject("w", noWide)).toThrow(/invalid parameter index/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 6. Client reports (PV7-04a, BFF §55.4): published only, and the strict reach
// ════════════════════════════════════════════════════════════════════════════════════════════════════
//
// A report on a project reaches that project's contacts and the client-wide ones; a report with no project reaches the
// client-wide contacts only (PV-D33, PV-D37). The HTTP proof is client-reports.db.test.ts.

describe("PV7-04a · client report predicates", () => {
  const S = scopeAt(2);

  it("row-state: published, and nothing else (a draft and a withdrawn report are never visible); it binds no parameters", () => {
    expect(clientReportClientVisible("cr")).toBe("cr.status = 'published'");
    expect(clientReportClientVisible("cr")).not.toMatch(/\$\d/);
  });

  it("the portal predicate is the caller's clients AND published AND the STRICT project arm (no project-less admission)", () => {
    expect(conjuncts(clientReportInPortalScope("cr", S))).toEqual(conjuncts(
      "cr.client_id = ANY($2::uuid[]) AND cr.status = 'published' AND (cr.client_id = ANY($3::uuid[]) OR cr.project_id = ANY($4::uuid[]))",
    ));
    expect(clientReportInPortalScope("cr", S)).toContain(wideOrOwnProject("cr", S));
    expect(clientReportInPortalScope("cr", S)).not.toMatch(/project_id IS NULL/);
    // The difference from the looser lists is the point: contracts and change requests admit a project-less row.
    expect(contractInPortalScope("k", S)).toMatch(/project_id IS NULL/);
  });

  it("staff flag: the report has a client AND is published, composed from the same row-state builder", () => {
    expect(staffClientReportClientVisible("cr")).toBe("(cr.client_id IS NOT NULL AND (cr.status = 'published'))");
  });

  it("refuses an alias that is not a plain identifier and a params object without `wide`", () => {
    expect(() => clientReportClientVisible("cr; DROP TABLE x")).toThrow(/invalid table alias/);
    expect(() => clientReportInPortalScope("CR", S)).toThrow(/invalid table alias/);
    expect(() => clientReportInPortalScope("cr", { clients: 1, projects: 2 } as never)).toThrow(/invalid parameter index/);
  });

  it("the Reports controller is discovered as portal-facing and is on the SWITCHED list", () => {
    const files = walk(SRC).filter((f) => !f.endsWith(`${sep}portal-visibility.ts`));
    const importers = files.filter((f) => importsPortalScope(readFileSync(f, "utf8"))).map(rel);
    expect(importers).toContain("src/core/portal-reports.controller.ts");
    expect(SWITCHED).toContain("src/core/portal-reports.controller.ts");
    // The download kind and the overview/deliverables additions live in two controllers already on the list.
    expect(SWITCHED).toContain("src/core/portal-commerce.controller.ts");
    expect(SWITCHED).toContain("src/core/portal-workspace.controller.ts");
  });
});
