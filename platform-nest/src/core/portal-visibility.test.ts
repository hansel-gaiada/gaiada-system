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
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  NEVER_CLIENT_VISIBLE, NEVER_CLIENT_VISIBLE_REASONS, PROJECT_SCOPE,
  changeRequestClientVisible, changeRequestInPortalScope, clientContactClientVisible, clientContactInPortalScope,
  contractClientVisible, contractInPortalScope, deliverableClientVisible, gateClientVisible, inCallerClients,
  invoiceClientVisible, invoiceInPortalScope, invoicePaymentClientVisible, invoicePaymentInPortalScope,
  milestoneClientVisible, postReviewClientVisible, postReviewInPortalScope, projectClientVisible,
  projectInPortalScope, projectReach, runClientVisible, runInPortalScope, runStageClientVisible,
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

const S12 = { clients: 1, projects: 2 };
const S23 = { clients: 2, projects: 3 };

interface Site { site: string; old: string; now: string }

const SITES: Site[] = [
  // ── portal-workspace.controller.ts ──
  { site: "workspace PROJECT_SCOPE (overview, projects, project detail, milestones, timeline, deliverables)",
    old: `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL`,
    now: PROJECT_SCOPE },
  { site: "workspace overview next milestone",
    old: `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL AND m.deleted_at IS NULL AND m.status <> 'done' AND m.due_date IS NOT NULL`,
    now: `${PROJECT_SCOPE} AND ${milestoneClientVisible("m")} AND m.status <> 'done' AND m.due_date IS NOT NULL` },
  { site: "workspace overview deliverable counts / deliverables list",
    old: `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL AND d.deleted_at IS NULL`,
    now: `${PROJECT_SCOPE} AND ${deliverableClientVisible("d")}` },
  { site: "workspace needsYou gates",
    old: `r.client_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
            AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL
            AND ($2::uuid[] IS NULL OR r.project_id = ANY($2::uuid[]))`,
    now: `${runInPortalScope("r", S12)} AND ${gateClientVisible("g")} AND g.status = 'pending'` },
  { site: "workspace finance invoices",
    old: `i.client_id = ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.status <> 'draft'`,
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
    old: `pp.deleted_at IS NULL AND pp.status = 'confirmed' AND pi.client_id = ANY($1::uuid[]) AND pi.deleted_at IS NULL AND pi.status <> 'draft'`,
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
    old: `i.id = $1 AND i.client_id = ANY($2::uuid[]) AND i.deleted_at IS NULL AND i.status <> 'draft'`,
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
                          AND i.client_id = ANY($2::uuid[]) AND i.deleted_at IS NULL AND i.status <> 'draft'`,
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

  // ── portal-profile.controller.ts (the People area, PV2-07) ──
  { site: "profile contacts (People)",
    old: `cc.client_id = ANY($1::uuid[]) AND cc.deleted_at IS NULL AND cc.status <> 'revoked'`,
    now: clientContactInPortalScope("cc", { clients: 1 }) },
];

describe("PV3-02 equivalence — every switched call site keeps its exact conjunct set", () => {
  it.each(SITES)("$site", ({ old, now }) => {
    expect(conjuncts(now)).toEqual(conjuncts(old));
  });

  it("PROJECT_SCOPE is character-for-character the old module-private constant", () => {
    expect(PROJECT_SCOPE).toBe(
      `p.client_id = ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[])) AND p.deleted_at IS NULL`,
    );
  });

  it("PV3-02b: the mail thread run branch differs from its old shape in exactly one conjunct (the NULL-project arm)", () => {
    const old = `r.id = $1 AND r.deleted_at IS NULL AND r.client_id = ANY($2::uuid[])
            AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]) OR r.project_id IS NULL)`;
    const now = `r.id = $1 AND ${runInPortalScope("r", S23)}`;
    expect(conjuncts(old).filter((c) => !conjuncts(now).includes(c))).toEqual([
      `($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]) OR r.project_id IS NULL)`,
    ]);
    expect(conjuncts(now).filter((c) => !conjuncts(old).includes(c))).toEqual([
      `($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]))`,
    ]);
  });

  it("PV3-02c: the scope-sign completion UPDATE gained exactly two conjuncts, the scope_signoff kind and the client-side gate", () => {
    const old = `id = $1 AND run_id = $3 AND status = 'pending' AND deleted_at IS NULL`;
    const now = `id = $1 AND run_id = $3 AND status = 'pending' AND kind = 'scope_signoff' AND ${gateClientVisible("")}`;
    expect(conjuncts(old).filter((c) => !conjuncts(now).includes(c))).toEqual([]);
    expect(conjuncts(now).filter((c) => !conjuncts(old).includes(c))).toEqual([`actor_side = 'client'`, `kind = 'scope_signoff'`]);
  });

  it("needsYou contracts: the ONLY added conjunct is `status <> 'draft'`, implied by `status = 'sent'`", () => {
    const old = `k.client_id = ANY($1::uuid[]) AND k.deleted_at IS NULL AND k.status = 'sent'
            AND ($2::uuid[] IS NULL OR k.project_id = ANY($2::uuid[]) OR k.project_id IS NULL)`;
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

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Builder contract
// ════════════════════════════════════════════════════════════════════════════════════════════════════

describe("PV3-02 builder contract", () => {
  it("binds whatever indexes the caller names, never a fixed $1/$2", () => {
    expect(contractInPortalScope("k", { clients: 7, projects: 9 })).toBe(
      `k.client_id = ANY($7::uuid[]) AND k.deleted_at IS NULL AND k.status <> 'draft' AND ($9::uuid[] IS NULL OR k.project_id = ANY($9::uuid[]) OR k.project_id IS NULL)`,
    );
    expect(invoiceInPortalScope("x", { clients: 4 })).toBe(`x.client_id = ANY($4::uuid[]) AND x.deleted_at IS NULL AND x.status <> 'draft'`);
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

  it("encodes the hidden report stage, client-side gates, non-draft money, and the two payment contexts", () => {
    expect(runStageClientVisible("s")).toBe(`s.track <> 'report'`);
    expect(gateClientVisible("g")).toBe(`g.actor_side = 'client' AND g.deleted_at IS NULL`);
    expect(contractClientVisible("k")).toBe(`k.deleted_at IS NULL AND k.status <> 'draft'`);
    expect(invoiceClientVisible("i")).toBe(`i.deleted_at IS NULL AND i.status <> 'draft'`);
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
    expect(() => runInPortalScope("r", { clients: 1, projects: -2 })).toThrow(/invalid parameter index/);
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
const RESOLVER_NAMES = ["resolvePortalScope", "callerClientIds", "requireSigner"];

function importsPortalScope(src: string): boolean {
  for (const m of src.matchAll(PORTAL_SCOPE_IMPORT)) {
    const names = m[1].split(",").map((n) => n.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim());
    if (names.some((n) => RESOLVER_NAMES.includes(n))) return true;
  }
  return false;
}

/** The old inline literals. Each one now has exactly one home in portal-visibility.ts. */
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "draft exclusion (contracts, invoices)", re: /status\s*<>\s*'draft'/ },
  { name: "client-side gate", re: /actor_side\s*=\s*'client'/ },
  { name: "hidden report stage", re: /track\s*<>\s*'report'/ },
  { name: "revoked-contact exclusion", re: /status\s*<>\s*'revoked'/ },
  // The project-scope NULL handling — the body of PROJECT_SCOPE and every run/contract/request copy of it.
  { name: "project-scope `$n::uuid[] IS NULL OR`", re: /\$\d+::uuid\[\]\s+IS\s+NULL\s+OR/ },
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
const NOT_YET_SWITCHED: Record<string, string> = {
  "src/core/client-website-access.controller.ts":
    "WSK-49f website-editor contact list (staff + portal surfaces): `cc.status <> 'revoked'` inline, plus " +
    "`cc.project_id IS NULL`, which the People predicate does not have. Outside PV3-02's owned paths.",
};

/** The portal controllers PV3-02 switched. The scan must find every one, or it is broken. */
const SWITCHED = [
  "src/core/portal-workspace.controller.ts",
  "src/core/portal-commerce.controller.ts",
  "src/core/portal.controller.ts",
  "src/core/webdev-change-requests-portal.controller.ts",
  "src/core/social-client-review-portal.controller.ts",
  "src/core/portal-profile.controller.ts",
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
      contractClientVisible("k"), gateClientVisible("g"), runStageClientVisible("s"),
      clientContactClientVisible("cc"), PROJECT_SCOPE,
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
