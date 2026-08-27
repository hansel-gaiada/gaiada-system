import "server-only";
// DEMO_MODE fixtures for the client-portal DASHBOARD (CP-2..CP-5) — overview, projects, timeline,
// deliverables, invoices/payments, contracts, profile. The run/gate routes stay in `demoPipeline.ts`
// (`portalDemo`), which this module runs BEFORE in the dispatch chain; anything it does not recognise
// falls through to there, so the two never overlap.
//
// Two properties are load-bearing, and both mirror the REAL BFF rather than merely producing pretty
// data:
//
//  1. IDENTITY-AWARE REFUSAL. Any non-`demo-client` caller gets 403 "not a portal client", exactly as
//     the real scope resolver does. Without it the demo would show a staff member a client dashboard
//     and the staff teach-state on `/portal` would be unreachable dead code — which is precisely how
//     the previous portal fixture was found to be hiding it.
//  2. THE CLAIM/CONFIRM SPLIT IS REAL HERE TOO. A payment recorded through the demo lands `pending`
//     and does NOT move the invoice's balance. A fixture that credited it immediately would make the
//     one behaviour most likely to be misread by a reviewer ("the client marked it paid?") look like
//     the intended design.
//
// Stateful, in-memory, per-process: signing a contract or recording a payment PERSISTS for the rest of
// the dev session, so the flows are drivable end to end (and by Playwright) rather than resetting on
// every navigation.
import type { DemoResult } from "./demoFixtures";

const CLIENT_ID = "cl-1";              // Northwind Traders — the client `demo-client` represents
const DEMO_CLIENT_USER = "demo-client";

const ok = (json: unknown): DemoResult => ({ status: 200, json });
const created = (json: unknown): DemoResult => ({ status: 201, json });
const bad = (error: string, field?: string): DemoResult => ({ status: 400, json: { error, field } });
const notFound = (error = "not found"): DemoResult => ({ status: 404, json: { error } });

/** Dates relative to today so the fixture never rots into "everything is overdue". */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function stamp(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

// ── Mutable state ─────────────────────────────────────────────────────────────────────────────────

interface DemoPayment {
  id: string; amount: number; currency: string; paidOn: string; method: string; reference: string | null;
  status: "pending" | "confirmed" | "rejected"; note: string | null; proofFileId: string | null;
  recordedAt: string; confirmedAt: string | null; rejectedReason: string | null;
}

const PROJECTS = [
  {
    id: "proj-nw-site", name: "Website relaunch", status: "active",
    startDate: day(-45), dueDate: day(30), clientId: CLIENT_ID, clientName: "Northwind Traders",
    progressPercent: 62, milestoneCount: 4, milestonesDone: 2, deliverableCount: 5, nextMilestoneDue: day(9),
  },
  {
    id: "proj-nw-brand", name: "Brand refresh", status: "active",
    startDate: day(-20), dueDate: day(60), clientId: CLIENT_ID, clientName: "Northwind Traders",
    progressPercent: 18, milestoneCount: 3, milestonesDone: 0, deliverableCount: 2, nextMilestoneDue: day(21),
  },
  {
    id: "proj-nw-2025", name: "Campaign — Q4 2025", status: "complete",
    startDate: day(-240), dueDate: day(-120), clientId: CLIENT_ID, clientName: "Northwind Traders",
    progressPercent: 100, milestoneCount: 2, milestonesDone: 2, deliverableCount: 4, nextMilestoneDue: null,
  },
];

const MILESTONES = [
  { id: "ms-1", name: "Discovery complete", status: "done", dueDate: day(-30), projectId: "proj-nw-site", projectName: "Website relaunch", itemCount: 6, itemsDone: 6 },
  { id: "ms-2", name: "Design approved", status: "done", dueDate: day(-8), projectId: "proj-nw-site", projectName: "Website relaunch", itemCount: 5, itemsDone: 5 },
  { id: "ms-3", name: "Build & content load", status: "open", dueDate: day(9), projectId: "proj-nw-site", projectName: "Website relaunch", itemCount: 12, itemsDone: 7 },
  { id: "ms-4", name: "Go live", status: "open", dueDate: day(30), projectId: "proj-nw-site", projectName: "Website relaunch", itemCount: 4, itemsDone: 0 },
  { id: "ms-5", name: "Brand audit", status: "open", dueDate: day(21), projectId: "proj-nw-brand", projectName: "Brand refresh", itemCount: 5, itemsDone: 1 },
  // A deliberately OVERDUE open milestone: the "upcoming vs history" split and the overdue styling are
  // both unreachable in the browser without one, and "no fixture has this state" is how such a branch
  // ships broken.
  { id: "ms-6", name: "Content sign-off", status: "open", dueDate: day(-3), projectId: "proj-nw-site", projectName: "Website relaunch", itemCount: 3, itemsDone: 1 },
];

const DELIVERABLES = [
  {
    id: "del-1", name: "Homepage design", status: "delivered", dueDate: day(-10), updatedAt: stamp(-9),
    projectId: "proj-nw-site", projectName: "Website relaunch", fileCount: 2,
    files: [
      { id: "file-del-1a", filename: "homepage-v3.pdf", contentType: "application/pdf", byteSize: 842_113, url: null, createdAt: stamp(-9) },
      { id: "file-del-1b", filename: "homepage-mobile.png", contentType: "image/png", byteSize: 331_442, url: null, createdAt: stamp(-9) },
    ],
  },
  {
    id: "del-2", name: "Content plan", status: "approved", dueDate: day(-4), updatedAt: stamp(-4),
    projectId: "proj-nw-site", projectName: "Website relaunch", fileCount: 1,
    files: [{ id: "file-del-2a", filename: "content-plan.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", byteSize: 55_120, url: null, createdAt: stamp(-4) }],
  },
  {
    id: "del-3", name: "Product pages build", status: "in_progress", dueDate: day(12), updatedAt: stamp(-1),
    projectId: "proj-nw-site", projectName: "Website relaunch", fileCount: 0, files: [],
  },
  {
    id: "del-4", name: "SEO migration map", status: "pending", dueDate: day(-2), updatedAt: stamp(-6),
    projectId: "proj-nw-site", projectName: "Website relaunch", fileCount: 0, files: [],
  },
  {
    id: "del-5", name: "Logo variations", status: "pending", dueDate: day(25), updatedAt: stamp(-2),
    projectId: "proj-nw-brand", projectName: "Brand refresh", fileCount: 0, files: [],
  },
];

interface DemoInvoice {
  id: string; status: string; currency: string; total: number;
  periodStart: string; periodEnd: string; issuedAt: string; clientName: string; clientId: string;
  lines: Array<{ description: string; hours: number; rate: number; amount: number }>;
}

const INVOICES: DemoInvoice[] = [
  {
    id: "inv-2026-014", status: "sent", currency: "IDR", total: 48_000_000,
    periodStart: day(-60), periodEnd: day(-31), issuedAt: stamp(-28),
    clientName: "Northwind Traders", clientId: CLIENT_ID,
    lines: [
      { description: "Website relaunch — design", hours: 96, rate: 350_000, amount: 33_600_000 },
      { description: "Website relaunch — build", hours: 48, rate: 300_000, amount: 14_400_000 },
    ],
  },
  {
    id: "inv-2026-021", status: "sent", currency: "IDR", total: 22_500_000,
    periodStart: day(-30), periodEnd: day(-1), issuedAt: stamp(-2),
    clientName: "Northwind Traders", clientId: CLIENT_ID,
    lines: [{ description: "Brand refresh — discovery", hours: 75, rate: 300_000, amount: 22_500_000 }],
  },
  {
    id: "inv-2025-088", status: "paid", currency: "IDR", total: 15_000_000,
    periodStart: day(-150), periodEnd: day(-121), issuedAt: stamp(-118),
    clientName: "Northwind Traders", clientId: CLIENT_ID,
    lines: [{ description: "Campaign — Q4 2025", hours: 50, rate: 300_000, amount: 15_000_000 }],
  },
];

const PAYMENTS: Record<string, DemoPayment[]> = {
  // The fully-settled historical invoice, so a "Paid" state is visible without acting.
  "inv-2025-088": [{
    id: "pay-h1", amount: 15_000_000, currency: "IDR", paidOn: day(-115), method: "bank_transfer",
    reference: "TRX-778812", status: "confirmed", note: null, proofFileId: null,
    recordedAt: stamp(-115), confirmedAt: stamp(-114), rejectedReason: null,
  }],
  // A partial confirmed payment on the oldest open invoice, so "balance < total" is visible too.
  "inv-2026-014": [{
    id: "pay-h2", amount: 20_000_000, currency: "IDR", paidOn: day(-20), method: "bank_transfer",
    reference: "TRX-889002", status: "confirmed", note: null, proofFileId: null,
    recordedAt: stamp(-20), confirmedAt: stamp(-19), rejectedReason: null,
  }],
};

interface DemoContract {
  id: string; title: string; reference: string; version: number; status: string;
  value: number; currency: string; startsOn: string; endsOn: string;
  sentAt: string | null; signedAt: string | null; projectId: string | null; projectName: string | null;
  bodyMd: string | null; fileId: string | null;
  signatures: Array<{ party: "provider" | "client"; signerName: string | null; signerTitle: string | null; signedAt: string }>;
}

const CONTRACTS: DemoContract[] = [
  {
    id: "ctr-msa-2026", title: "Master Services Agreement", reference: "GDA-2026-004", version: 2,
    status: "signed", value: 240_000_000, currency: "IDR", startsOn: day(-90), endsOn: day(275),
    sentAt: stamp(-95), signedAt: stamp(-90), projectId: null, projectName: null,
    bodyMd: null, fileId: "file-ctr-msa",
    signatures: [
      { party: "provider", signerName: "D. Syrowatka", signerTitle: "Director", signedAt: stamp(-91) },
      { party: "client", signerName: "Dana Whitfield", signerTitle: "Marketing Lead", signedAt: stamp(-90) },
    ],
  },
  {
    // The actionable one: sent, provider already countersigned, waiting on the client. This is the
    // state the whole sign flow exists for, so the fixture must ship in it.
    id: "ctr-sow-site", title: "Statement of Work — Website relaunch", reference: "GDA-2026-014", version: 1,
    status: "sent", value: 62_400_000, currency: "IDR", startsOn: day(-2), endsOn: day(120),
    sentAt: stamp(-2), signedAt: null, projectId: "proj-nw-site", projectName: "Website relaunch",
    bodyMd: [
      "## Scope",
      "",
      "Design and build of the Northwind Traders public website, comprising:",
      "",
      "- Discovery workshop and information architecture",
      "- Visual design for 6 page templates",
      "- Build, content load and SEO migration",
      "- Two rounds of revisions per template",
      "",
      "## Term and fees",
      "",
      "Fees are invoiced monthly against delivered milestones. Out-of-scope requests are quoted",
      "separately and require written approval before work begins.",
    ].join("\n"),
    fileId: null,
    signatures: [{ party: "provider", signerName: "D. Syrowatka", signerTitle: "Director", signedAt: stamp(-2) }],
  },
  {
    id: "ctr-sow-brand", title: "Statement of Work — Brand refresh", reference: "GDA-2026-019", version: 1,
    status: "sent", value: 45_000_000, currency: "IDR", startsOn: day(-1), endsOn: day(180),
    sentAt: stamp(-1), signedAt: null, projectId: "proj-nw-brand", projectName: "Brand refresh",
    bodyMd: "## Scope\n\nBrand audit, positioning and a refreshed visual identity system.",
    fileId: null,
    signatures: [],
  },
];

let profileName = "Dana Whitfield";
let profileTitle = "Marketing Lead, Northwind Traders";
const CHANGE_REQUESTS: string[] = [];
let demoSeq = 0;
const nextId = (p: string) => `${p}-demo-${++demoSeq}`;

// ── MI-04: maintenance intake (webdev change requests) ─────────────────────────────────────────────
//
// A DIFFERENT thing from `CHANGE_REQUESTS` above (which is the unrelated "change my own profile info"
// ask from CP-15) — naming collision with the real feature avoided on purpose, since a reviewer
// searching for "change request" in this file must not find the wrong one.
//
// `demo-client` is CLIENT-WIDE (see the `profile` GET below: `access.wholeClient: true`), so this
// fixture alone cannot drive the PROJECT-SCOPED half of the §5.1 project rule (a project-scoped
// contact getting no "all projects" option, or being refused a NULL project) — the task brief is
// explicit that a second client identity must not be invented to cover it. That half is pinned
// instead as a pure-function unit test in `lib/portal.test.ts` (`changeRequestFormProps`), which
// exercises both scope shapes directly without needing a second login.
interface DemoChangeRequest {
  id: string; kind: string; title: string; body: string | null;
  status: string; route: string | null;
  clientId: string; projectId: string | null; projectName: string | null;
  pipelineRunId: string | null; pmTaskId: string | null;
  declinedReason: string | null; requestedBy: string;
  createdAt: string; updatedAt: string;
  // Bug detail (BFF contract §16f). Carried here so demo mode cannot quietly serve a SHORTER row
  // than the real backend — a field the fixture omits is indistinguishable, at the reader, from one
  // the backend never sends, which is the frontend-drift bug class this file otherwise guards well.
  // `severity` is always null on the intake path: it is set at triage, never by the reporter.
  severity: string | null;
  reproSteps: string | null; environment: string | null;
  seenOnVersion: string | null; affectedUrl: string | null;
}
// ── WHY THIS STORE IS PINNED TO globalThis (found by a clean e2e run, 2026-08-08) ────────────────
// A plain module-level array does NOT work here. Next bundles the `"use server"` action graph and the
// page's RSC graph separately, so `portalSubmitChangeRequest`'s POST pushed onto one instance of this
// array while the page's GET read a different one: the write returned 201, the success banner showed,
// and the request the client had just filed was absent from the list.
//
// It passed an in-process vitest ("create then immediately re-read") because that test has ONE module
// instance by construction — it exercised the store, never the bundling. That is the trap worth
// remembering: the substitute proof was sound about the thing it tested and silent about the thing
// that broke. Only the real browser against the real server could see it.
//
// `globalThis` gives every copy of this module the same array. Demo-only state, so a single process-
// wide store is exactly the intended lifetime (it also survives dev HMR, which a module-level `const`
// silently does not).
const CR_STORE_KEY = Symbol.for("gaiada.demoPortal.webdevChangeRequests");
const WEBDEV_CRS: DemoChangeRequest[] = ((globalThis as Record<symbol, unknown>)[CR_STORE_KEY] ??= [
  // in_progress + a real pipelineRunId — the deep-link to the EXISTING /portal/approvals/run-demo-1
  // (demoPipeline's RUNS) must land on real content, not a dead id invented just for this fixture.
  {
    id: "wcr-seed-1", kind: "feature", title: "Add a live chat widget to the homepage",
    body: "Our support team keeps fielding the same three questions — could we add a chat bubble?",
    status: "in_progress", route: "mini_run", clientId: CLIENT_ID,
    projectId: "proj-nw-site", projectName: "Website relaunch",
    pipelineRunId: "run-demo-1", pmTaskId: null, declinedReason: null,
    requestedBy: DEMO_CLIENT_USER, createdAt: stamp(-6), updatedAt: stamp(-5),
    // Not a bug — every bug-detail column is honestly null, which is what the backend returns.
    severity: null, reproSteps: null, environment: null, seenOnVersion: null, affectedUrl: null,
  },
  // declined + a reason — the one branch nothing else in this fixture set exercises.
  {
    id: "wcr-seed-2", kind: "content", title: "Update the Bali office phone number",
    body: "It changed last month — the old one still rings a disconnected line.",
    status: "declined", route: null, clientId: CLIENT_ID, projectId: null, projectName: null,
    pipelineRunId: null, pmTaskId: null,
    declinedReason: "This is a footer edit our team can make directly — done as of today, no need to track it as a request.",
    requestedBy: DEMO_CLIENT_USER, createdAt: stamp(-10), updatedAt: stamp(-9),
    severity: null, reproSteps: null, environment: null, seenOnVersion: null, affectedUrl: null,
  },
  // untouched `new` — the triage queue's own state, so the portal side shows what "just submitted,
  // nobody's looked at it yet" looks like without requiring a fresh POST first.
  {
    id: "wcr-seed-3", kind: "bug", title: "Checkout button does nothing on Safari",
    body: null, status: "new", route: null, clientId: CLIENT_ID,
    projectId: "proj-nw-site", projectName: "Website relaunch",
    pipelineRunId: null, pmTaskId: null, declinedReason: null,
    requestedBy: DEMO_CLIENT_USER, createdAt: stamp(-1), updatedAt: stamp(-1),
    // The one seed that exercises bug detail end to end. `severity` is null and MUST be: this row is
    // `status: "new"`, i.e. pre-triage, and `wcr_bug_has_severity` only obliges a severity once a bug
    // leaves triage. A fixture that pre-ranked it would model a row the database cannot hold.
    severity: null,
    reproSteps: "1. Add anything to the basket\n2. Open the basket on an iPhone\n3. Tap Checkout — nothing happens",
    environment: "the live site",
    seenOnVersion: null,
    affectedUrl: "https://example.test/checkout",
  },
]) as DemoChangeRequest[];

// ── Derivations ───────────────────────────────────────────────────────────────────────────────────

function paymentsOf(invoiceId: string): DemoPayment[] {
  return PAYMENTS[invoiceId] ?? [];
}
function confirmedSum(invoiceId: string): number {
  return paymentsOf(invoiceId).filter((p) => p.status === "confirmed").reduce((s, p) => s + p.amount, 0);
}
function pendingSum(invoiceId: string): number {
  return paymentsOf(invoiceId).filter((p) => p.status === "pending").reduce((s, p) => s + p.amount, 0);
}
function isOverdue(inv: DemoInvoice): boolean {
  return inv.status === "sent" && inv.periodEnd < day(0);
}
function invoiceSummary(inv: DemoInvoice) {
  const paid = confirmedSum(inv.id);
  return {
    id: inv.id, status: inv.status, currency: inv.currency, total: inv.total,
    periodStart: inv.periodStart, periodEnd: inv.periodEnd, issuedAt: inv.issuedAt,
    clientName: inv.clientName, paid, pendingConfirmation: pendingSum(inv.id),
    balance: Math.round((inv.total - paid) * 100) / 100, overdue: isOverdue(inv),
  };
}
function contractSummary(k: DemoContract) {
  return {
    id: k.id, title: k.title, reference: k.reference, version: k.version, status: k.status,
    value: k.value, currency: k.currency, startsOn: k.startsOn, endsOn: k.endsOn,
    sentAt: k.sentAt, signedAt: k.signedAt, projectId: k.projectId, projectName: k.projectName,
    hasDocument: k.fileId !== null,
    clientSigned: k.signatures.some((s) => s.party === "client"),
    providerSigned: k.signatures.some((s) => s.party === "provider"),
    termEnded: k.endsOn < day(0),
  };
}

/** "Needs you", assembled the same way the BFF does: pending client gates first, then unsigned sent
 *  contracts, oldest first. The gate half is hard-coded to match demoPipeline's own pending gate so
 *  the two fixtures do not contradict each other on the overview. */
function needsYou() {
  const items = [
    {
      kind: "gate" as const, id: "gate-demo-2", requires: "signature" as const,
      label: "Sign off the project requirements", context: "Northwind — website relaunch",
      href: "/portal/approvals/run-demo-1", since: stamp(-3),
    },
    ...CONTRACTS.filter((k) => k.status === "sent" && !k.signatures.some((s) => s.party === "client"))
      .map((k) => ({
        kind: "contract" as const, id: k.id, requires: "signature" as const,
        label: "Sign your agreement", context: k.title, href: `/portal/contracts/${k.id}`, since: k.sentAt,
      })),
  ];
  return items.sort((a, b) => String(a.since).localeCompare(String(b.since)));
}

function financeTotals() {
  const open = INVOICES.filter((i) => i.status !== "draft" && i.status !== "void");
  const invoiced = open.reduce((s, i) => s + i.total, 0);
  const paid = open.reduce((s, i) => s + confirmedSum(i.id), 0);
  const totals = {
    currency: "IDR",
    invoiced,
    paid,
    pendingConfirmation: open.reduce((s, i) => s + pendingSum(i.id), 0),
    outstanding: Math.round((invoiced - paid) * 100) / 100,
    overdueCount: open.filter(isOverdue).length,
    openCount: open.filter((i) => i.status === "sent").length,
  };
  return { byCurrency: [totals], primary: totals };
}

function timeline() {
  const events = [
    ...MILESTONES.map((m) => ({
      kind: "milestone" as const, id: m.id, label: m.name, status: m.status,
      at: `${m.dueDate}T00:00:00.000Z`, tense: "due" as const, context: m.projectName, projectId: m.projectId,
    })),
    ...DELIVERABLES.map((d) => {
      const settled = ["delivered", "approved", "done"].includes(d.status);
      return {
        kind: "deliverable" as const, id: d.id, label: d.name, status: d.status,
        at: settled ? d.updatedAt : `${d.dueDate}T00:00:00.000Z`,
        tense: settled ? ("happened" as const) : ("due" as const),
        context: d.projectName, projectId: d.projectId,
      };
    }),
    ...CONTRACTS.map((k) => ({
      kind: "contract" as const, id: k.id, label: k.title, status: k.status,
      at: k.signedAt ?? k.sentAt ?? stamp(-100), tense: "happened" as const,
      context: k.reference, projectId: k.projectId,
    })),
    ...INVOICES.map((i) => ({
      kind: "invoice" as const, id: i.id, label: `Invoice ${i.id}`, status: i.status,
      at: i.issuedAt, tense: "happened" as const, context: `IDR ${i.total}`, projectId: null,
    })),
    ...Object.entries(PAYMENTS).flatMap(([, list]) =>
      list.filter((p) => p.status === "confirmed").map((p) => ({
        kind: "payment" as const, id: p.id, label: "Payment received", status: p.status,
        at: p.confirmedAt ?? p.recordedAt, tense: "happened" as const,
        context: `IDR ${p.amount}`, projectId: null,
      }))),
    {
      kind: "decision" as const, id: "gate-demo-1", label: "Scope Agreement signed", status: "signed",
      at: stamp(-40), tense: "happened" as const, context: "Northwind — website relaunch", projectId: "proj-nw-site",
    },
  ];
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

// ── Dispatch ──────────────────────────────────────────────────────────────────────────────────────

export function portalDashboardDemo(method: string, p: string, userId: string, body?: string): DemoResult | null {
  const m = method.toUpperCase();
  if (!/^\/api\/[^/]+\/portal\//.test(p)) return null;
  // Route table FIRST, identity check second — but only for routes this module owns, so unmatched
  // portal routes still fall through to `portalDemo` (runs/gates) rather than being 403'd here.
  const seg = p.replace(/^\/api\/[^/]+\/portal\//, "");
  const OWNED = /^(overview|projects|milestones|timeline|deliverables|invoices|contracts|profile|stream|files|change-requests)(\/|$)/;
  if (!OWNED.test(seg)) return null;
  if (userId !== DEMO_CLIENT_USER) return { status: 403, json: { error: "not a portal client" } };

  const parsed: Record<string, unknown> = (() => {
    if (!body) return {};
    try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; }
  })();

  // ── overview ──
  if (seg === "overview" && m === "GET") {
    const active = PROJECTS.filter((x) => x.status !== "complete");
    return ok({
      clients: [{ id: CLIENT_ID, name: "Northwind Traders", status: "active" }],
      client: { id: CLIENT_ID, name: "Northwind Traders", status: "active" },
      viewOnly: false,
      progress: {
        projects: PROJECTS.length,
        activeProjects: active.length,
        completedProjects: PROJECTS.length - active.length,
        percent: Math.round(PROJECTS.reduce((s, x) => s + x.progressPercent, 0) / PROJECTS.length),
      },
      deliverables: {
        total: DELIVERABLES.length,
        delivered: DELIVERABLES.filter((d) => ["delivered", "approved", "done"].includes(d.status)).length,
        overdue: DELIVERABLES.filter((d) => d.dueDate < day(0) && !["delivered", "approved", "done"].includes(d.status)).length,
      },
      nextMilestone: (() => {
        const next = MILESTONES.filter((x) => x.status !== "done").sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
        return next ? { id: next.id, name: next.name, dueDate: next.dueDate, status: next.status, projectId: next.projectId, projectName: next.projectName } : null;
      })(),
      needsYou: needsYou(),
      finance: financeTotals(),
    });
  }

  // ── projects ──
  if (seg === "projects" && m === "GET") return ok(PROJECTS);
  const projM = seg.match(/^projects\/([^/]+)$/);
  if (projM && m === "GET") {
    const proj = PROJECTS.find((x) => x.id === projM[1]);
    if (!proj) return notFound("project not found");
    return ok({
      ...proj,
      milestones: MILESTONES.filter((x) => x.projectId === proj.id),
      deliverables: DELIVERABLES.filter((x) => x.projectId === proj.id),
      runs: proj.id === "proj-nw-site"
        ? [{ id: "run-demo-1", title: "Northwind — website relaunch", status: "awaiting_gate", pendingActions: 1 }]
        : [],
      workload: proj.id === "proj-nw-site"
        ? { todo: 5, in_progress: 4, blocked: 1, done: 12 }
        : { todo: 6, in_progress: 1, blocked: 0, done: 2 },
    });
  }

  if (seg === "milestones" && m === "GET") {
    return ok([...MILESTONES].sort((a, b) => a.dueDate.localeCompare(b.dueDate)));
  }
  if (seg.startsWith("timeline") && m === "GET") return ok(timeline());

  // ── deliverables ──
  if (seg.startsWith("deliverables") && m === "GET") {
    const q = new URL(p, "http://demo").searchParams.get("projectId");
    return ok(q ? DELIVERABLES.filter((d) => d.projectId === q) : DELIVERABLES);
  }

  // ── invoices + payments ──
  if (seg === "invoices" && m === "GET") return ok(INVOICES.map(invoiceSummary));
  const invM = seg.match(/^invoices\/([^/]+)$/);
  if (invM && m === "GET") {
    const inv = INVOICES.find((x) => x.id === invM[1]);
    if (!inv) return notFound("invoice not found");
    const paid = confirmedSum(inv.id);
    return ok({
      ...inv, payments: paymentsOf(inv.id), paid, balance: Math.round((inv.total - paid) * 100) / 100,
    });
  }
  const payM = seg.match(/^invoices\/([^/]+)\/payments$/);
  if (payM && m === "POST") {
    const inv = INVOICES.find((x) => x.id === payM[1]);
    if (!inv) return notFound("invoice not found");
    const amount = Number(parsed.amount);
    const paidOn = String(parsed.paidOn ?? "");
    if (!Number.isFinite(amount) || amount <= 0) return bad("amount must be a positive number", "amount");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return bad("paidOn must be YYYY-MM-DD", "paidOn");
    if (paidOn > day(0)) return bad("paidOn cannot be in the future", "paidOn");
    // The same overpayment guard, with the same tolerance and the same message shape, so the error
    // path is drivable in the browser rather than only reachable against a real backend.
    const already = paymentsOf(inv.id).filter((x) => x.status !== "rejected").reduce((s, x) => s + x.amount, 0);
    if (already + amount > inv.total * 1.01) {
      return bad(`amount exceeds the outstanding balance (${Math.max(0, inv.total - already)} ${inv.currency})`, "amount");
    }
    const id = nextId("pay");
    const proof = parsed.proof as { filename?: string; content?: string } | undefined;
    (PAYMENTS[inv.id] ||= []).push({
      id, amount, currency: inv.currency, paidOn,
      method: String(parsed.method ?? "bank_transfer"),
      reference: parsed.reference ? String(parsed.reference) : null,
      // PENDING, and no balance movement — see this file's header.
      status: "pending",
      note: parsed.note ? String(parsed.note) : null,
      proofFileId: proof?.content ? nextId("file") : null,
      recordedAt: new Date().toISOString(), confirmedAt: null, rejectedReason: null,
    });
    return created({ id, status: "pending", proofFileId: null });
  }

  // ── contracts ──
  if (seg === "contracts" && m === "GET") {
    return ok(CONTRACTS.filter((k) => k.status !== "draft").map(contractSummary));
  }
  const ctrM = seg.match(/^contracts\/([^/]+)$/);
  if (ctrM && m === "GET") {
    const k = CONTRACTS.find((x) => x.id === ctrM[1]);
    if (!k) return notFound("contract not found");
    const s = contractSummary(k);
    return ok({
      id: k.id, title: k.title, reference: k.reference, version: k.version, status: k.status,
      value: k.value, currency: k.currency, startsOn: k.startsOn, endsOn: k.endsOn,
      sentAt: k.sentAt, signedAt: k.signedAt, projectId: k.projectId,
      bodyMd: k.bodyMd, declineReason: null, termEnded: s.termEnded,
      canSign: k.status === "sent" && !s.clientSigned && !s.termEnded,
      viewOnly: false,
      signatures: k.signatures,
      document: k.fileId
        ? { id: k.fileId, filename: `${k.reference}.pdf`, contentType: "application/pdf", byteSize: 214_882, url: null }
        : null,
    });
  }
  const signM = seg.match(/^contracts\/([^/]+)\/sign$/);
  if (signM && m === "POST") {
    const k = CONTRACTS.find((x) => x.id === signM[1]);
    if (!k) return notFound("contract not found");
    if (parsed.agree !== true) return bad("you must confirm you agree to the terms", "agree");
    const signerName = String(parsed.signerName ?? "").trim();
    if (signerName.length < 2) return bad("signerName required", "signerName");
    // Already-signed BEFORE status, mirroring the BFF: signing is what flips the status to `signed`, so
    // checking status first answered 400 "already signed and cannot be signed" to a double-tapped button
    // on the most consequential action in the portal. The fixture caught it in the real controller too.
    if (k.signatures.some((s) => s.party === "client")) {
      return ok({ id: k.id, party: "client", complete: k.status === "signed", alreadySigned: true });
    }
    if (k.status !== "sent") return bad(`this agreement is ${k.status} and cannot be signed`);
    k.signatures.push({ party: "client", signerName, signerTitle: parsed.signerTitle ? String(parsed.signerTitle) : null, signedAt: new Date().toISOString() });
    const complete = k.signatures.some((s) => s.party === "provider");
    if (complete) {
      k.status = "signed";
      k.signedAt = new Date().toISOString();
    }
    return ok({ id: k.id, party: "client", complete, alreadySigned: false });
  }

  // ── profile ──
  if (seg === "profile" && m === "GET") {
    return ok({
      me: { id: DEMO_CLIENT_USER, name: profileName, email: "dana@northwind.example", title: profileTitle, memberSince: stamp(-400) },
      clients: [{
        id: CLIENT_ID, name: "Northwind Traders", status: "active", projectCount: PROJECTS.length,
        contact: { email: "accounts@northwind.example", phone: "+62 361 555 0134", address: "Jl. Raya Seminyak 12, Bali" },
      }],
      contacts: [
        { id: DEMO_CLIENT_USER, name: profileName, email: "dana@northwind.example", capability: "signer", status: "active", clientId: CLIENT_ID, projectId: null },
        { id: "nw-2", name: "Erica Boonstra", email: "erica@northwind.example", capability: "viewer", status: "active", clientId: CLIENT_ID, projectId: "proj-nw-site" },
        { id: "nw-3", name: "Marco Halim", email: "marco@northwind.example", capability: "viewer", status: "invited", clientId: CLIENT_ID, projectId: null },
      ],
      access: {
        canSign: true, wholeClient: true,
        grants: [{ capability: "signer", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null }],
      },
    });
  }
  if (seg === "profile" && m === "PATCH") {
    if (typeof parsed.name === "string" && parsed.name.trim().length >= 2) profileName = parsed.name.trim();
    if (typeof parsed.title === "string") profileTitle = parsed.title.trim();
    return ok({ ok: true });
  }
  if (seg === "profile/change-request" && m === "POST") {
    const message = String(parsed.message ?? "").trim();
    if (message.length < 5) return bad("message required", "message");
    CHANGE_REQUESTS.push(message);
    return { status: 202, json: { accepted: true, notified: 1 } };
  }

  // ── change requests (MI-04) ──
  // List: newest first, mirroring the real controller's `ORDER BY created_at DESC`.
  if (seg === "change-requests" && m === "GET") {
    return ok([...WEBDEV_CRS].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  const crDetailM = seg.match(/^change-requests\/([^/]+)$/);
  if (crDetailM && m === "GET") {
    const row = WEBDEV_CRS.find((r) => r.id === crDetailM[1]);
    if (!row) return notFound("request not found");
    return ok(row);
  }
  if (seg === "change-requests" && m === "POST") {
    const kind = String(parsed.kind ?? "");
    if (!["content", "design", "feature", "bug"].includes(kind)) {
      return bad("kind must be one of content|design|feature|bug", "kind");
    }
    const title = String(parsed.title ?? "").trim();
    if (!title) return bad("title is required", "title");
    // demo-client is CLIENT-WIDE (see the `profile` GET below), so a NULL project is always valid
    // here — the project-scoped refusal path is proven by a unit test instead (this file's header).
    let projectId: string | null = null;
    let projectName: string | null = null;
    if (typeof parsed.projectId === "string" && parsed.projectId) {
      const proj = PROJECTS.find((p) => p.id === parsed.projectId && p.clientId === CLIENT_ID);
      if (!proj) return bad("project not found");
      projectId = proj.id;
      projectName = proj.name;
    }
    const id = nextId("wcr");
    // Only kind/title/body/projectId are ever read from `parsed` — a body-supplied `status` or
    // `clientId` is never even looked at, mirroring the real controller's "never body-trusted" rule.
    const row: DemoChangeRequest = {
      id, kind, title, body: parsed.body ? String(parsed.body) : null,
      status: "new", route: null, clientId: CLIENT_ID, projectId, projectName,
      pipelineRunId: null, pmTaskId: null, declinedReason: null, requestedBy: DEMO_CLIENT_USER,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      // Accepted for any kind, exactly like the real controller — the FORM only offers them for
      // `bug`, so they simply arrive absent for other kinds rather than being refused here.
      // `severity` is NOT read from `parsed`, deliberately: a body-supplied severity is ignored, the
      // same way status/clientId are, which is what the real endpoint does.
      severity: null,
      reproSteps: parsed.reproSteps ? String(parsed.reproSteps) : null,
      environment: parsed.environment ? String(parsed.environment) : null,
      seenOnVersion: parsed.seenOnVersion ? String(parsed.seenOnVersion) : null,
      affectedUrl: parsed.affectedUrl ? String(parsed.affectedUrl) : null,
    };
    WEBDEV_CRS.push(row);
    return created({ id, status: "new" });
  }

  // ── files ──
  // A real download streams bytes, which `getDemoResponse` (JSON-only) cannot represent. Answering 404
  // is the honest fixture: the link renders, and clicking it fails visibly instead of appearing to
  // deliver an empty file.
  if (seg.startsWith("files/")) return notFound("no stored content in demo mode");

  // ── stream ──
  // SSE is not representable here either. `mode: "poll"` is exactly what the client falls back to when
  // the backbone is unavailable, so demo mode exercises the FALLBACK path — which is the one most
  // likely to be broken and least likely to be tested.
  if (seg === "stream") return ok({ mode: "poll" });

  return null;
}
