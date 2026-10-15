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
import { isDemoPortalClient } from "./demoPortalClients";
import { portalCallerContact, portalProfileContacts } from "./demoWebsiteAccess";

const CLIENT_ID = "cl-1";              // Northwind Traders — the client `demo-client` represents
const DEMO_CLIENT_USER = "demo-client";

const ok = (json: unknown): DemoResult => ({ status: 200, json });
const created = (json: unknown): DemoResult => ({ status: 201, json });
const bad = (error: string, field?: string): DemoResult => ({ status: 400, json: { error, field } });
const notFound = (error = "not found"): DemoResult => ({ status: 404, json: { error } });
/** PV-D41: the demo's one simulated order (inv-2026-014) and its simulated state. */
const DEMO_SIM_ORDER = "ck-demo-sim";
let demoSimStatus: string | null = null;
const conflict = (error: string, reason?: string): DemoResult => ({ status: 409, json: { error, reason } });

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
    id: "proj-nw-site", name: "Website relaunch", status: "active", finished: false,
    startDate: day(-45), dueDate: day(30), clientId: CLIENT_ID, clientName: "Northwind Traders",
    progressPercent: 62, milestoneCount: 4, milestonesDone: 2, deliverableCount: 5, nextMilestoneDue: day(9),
  },
  {
    id: "proj-nw-brand", name: "Brand refresh", status: "active", finished: false,
    startDate: day(-20), dueDate: day(60), clientId: CLIENT_ID, clientName: "Northwind Traders",
    progressPercent: 18, milestoneCount: 3, milestonesDone: 0, deliverableCount: 2, nextMilestoneDue: day(21),
  },
  {
    id: "proj-nw-2025", name: "Campaign — Q4 2025", status: "complete", finished: true,
    startDate: day(-240), dueDate: day(-120), clientId: CLIENT_ID, clientName: "Northwind Traders",
    progressPercent: 100, milestoneCount: 2, milestonesDone: 2, deliverableCount: 4, nextMilestoneDue: null,
  },
];

/** Project leads (`projects.owner_id` → users) as the portal payload exposes them: name + email only. */
const PROJECT_LEADS: Record<string, { name: string; email: string }> = {
  "proj-nw-site": { name: "Putu Wirawan", email: "putu@gaiada.example" },
  "proj-nw-brand": { name: "Sari Anggraini", email: "sari@gaiada.example" },
};

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
  // PV5-04/PV5-07: the invoice of record. An issued invoice carries its number, dates, the frozen issuer and, once rendered,
  // its PDF (`null` = not rendered yet, which the page says as "being prepared").
  invoiceNo: string; issueDate: string; dueDate: string; subtotal: number; taxTotal: number | null; taxCode: string | null;
  taxRate: number | null; pdfFileId: string | null;
}

/** The issuer as frozen at issue. Invented placeholders: the repo is public, and nothing here is a real company or account. */
const DEMO_ISSUER = {
  legalName: "Example Agency Ltd",
  address: "1 Example Street\nExample City 00000",
  npwp: "00.000.000.0-000.000",
  isPkp: true,
  bank: { name: "Example Bank", accountName: "Example Agency Ltd", accountNo: "0000000000" },
};

const INVOICES: DemoInvoice[] = [
  {
    id: "inv-2026-014", status: "sent", currency: "IDR", total: 48_000_000,
    periodStart: day(-60), periodEnd: day(-31), issuedAt: stamp(-28),
    clientName: "Northwind Traders", clientId: CLIENT_ID,
    lines: [
      { description: "Website relaunch — design", hours: 96, rate: 350_000, amount: 33_600_000 },
      { description: "Website relaunch — build", hours: 48, rate: 300_000, amount: 14_400_000 },
    ],
    invoiceNo: "DEMO/2026/0014", issueDate: day(-28), dueDate: day(2), subtotal: 48_000_000, taxTotal: null, taxCode: null,
    taxRate: null, pdfFileId: "file-inv-2026-014",
  },
  {
    // The taxed one (subtotal 22,500,000 + PPN 11% = 2,475,000), whose PDF has NOT been rendered yet: "being prepared".
    id: "inv-2026-021", status: "sent", currency: "IDR", total: 24_975_000,
    periodStart: day(-30), periodEnd: day(-1), issuedAt: stamp(-2),
    clientName: "Northwind Traders", clientId: CLIENT_ID,
    lines: [{ description: "Brand refresh — discovery", hours: 75, rate: 300_000, amount: 22_500_000 }],
    invoiceNo: "DEMO/2026/0021", issueDate: day(-2), dueDate: day(28), subtotal: 22_500_000, taxTotal: 2_475_000, taxCode: "PPN",
    taxRate: 11, pdfFileId: null,
  },
  {
    id: "inv-2025-088", status: "paid", currency: "IDR", total: 15_000_000,
    periodStart: day(-150), periodEnd: day(-121), issuedAt: stamp(-118),
    clientName: "Northwind Traders", clientId: CLIENT_ID,
    lines: [{ description: "Campaign — Q4 2025", hours: 50, rate: 300_000, amount: 15_000_000 }],
    invoiceNo: "DEMO/2025/0088", issueDate: day(-118), dueDate: day(-88), subtotal: 15_000_000, taxTotal: null, taxCode: null,
    taxRate: null, pdfFileId: "file-inv-2025-088",
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
  // PV5-06/PV5-07: the SHA-256 fixed at send, the tier, and the sealed signed copy (null until rendered).
  contentSha256: string; signatureTier: "attested" | "certified"; signedCopyFileId: string | null;
  /** PV4-04: an amendment names the contract it amends and (optionally) the change request it came from. */
  kind?: "agreement" | "amendment"; amendsId?: string | null; amendsReference?: string | null; changeRequestId?: string | null;
  /** PV5-11: a certified contract signed through the SIMULATED PSrE (review stage): its provider and envelope. */
  signatureProvider?: string | null; providerEnvelopeId?: string | null;
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
    contentSha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", signatureTier: "attested",
    signedCopyFileId: "file-ctr-msa-signed",
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
    contentSha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0", signatureTier: "attested",
    signedCopyFileId: null,
  },
  {
    // PV4-08: an amendment that is already signed, so the "needs you" list and the unsigned-contract counts the
    // other fixtures and specs rely on do not move. It shows the banner: "Amendment to GDA-2026-004" and
    // "From your request" (the seeded change request wcr-seed-1).
    id: "ctr-amd-msa-1", title: "Amendment 1 — Master Services Agreement", reference: "GDA-2026-004-A1", version: 1,
    status: "signed", value: 12_000_000, currency: "IDR", startsOn: day(-20), endsOn: day(275),
    sentAt: stamp(-22), signedAt: stamp(-20), projectId: null, projectName: null,
    bodyMd: "## Change\n\nAdds a live chat widget to the homepage scope, as requested.",
    fileId: null,
    signatures: [
      { party: "provider", signerName: "D. Syrowatka", signerTitle: "Director", signedAt: stamp(-21) },
      { party: "client", signerName: "Dana Whitfield", signerTitle: "Marketing Lead", signedAt: stamp(-20) },
    ],
    kind: "amendment", amendsId: "ctr-msa-2026", amendsReference: "GDA-2026-004", changeRequestId: "wcr-seed-1",
    // Signed, and its sealed copy is not rendered yet: the page says "being prepared".
    contentSha256: "5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d", signatureTier: "attested", signedCopyFileId: null,
  },
  {
    id: "ctr-sow-brand", title: "Statement of Work — Brand refresh", reference: "GDA-2026-019", version: 1,
    status: "sent", value: 45_000_000, currency: "IDR", startsOn: day(-1), endsOn: day(180),
    sentAt: stamp(-1), signedAt: null, projectId: "proj-nw-brand", projectName: "Brand refresh",
    bodyMd: "## Scope\n\nBrand audit, positioning and a refreshed visual identity system.",
    fileId: null,
    signatures: [],
    contentSha256: "9e8d7c6b5a49382716059e8d7c6b5a49382716059e8d7c6b5a49382716059e8d", signatureTier: "attested",
    signedCopyFileId: null,
  },
  {
    // PV5-11 (PV-D43): a CERTIFIED agreement, sent, signed through the SIMULATED PSrE. The client has reached the sign step
    // (its envelope exists), so the contract page offers "Sign with Simulated PSrE (review stage)" and the envelope's
    // simulated signing pages (portal and staff) are drivable.
    id: "ctr-certified-retainer", title: "Retainer agreement (certified)", reference: "GDA-2026-022", version: 1,
    status: "sent", value: 180_000_000, currency: "IDR", startsOn: day(0), endsOn: day(365),
    sentAt: stamp(-1), signedAt: null, projectId: null, projectName: null,
    bodyMd: "## Retainer\n\nA monthly retainer for website care, signed with a certified electronic signature.",
    fileId: null,
    signatures: [],
    contentSha256: "c3e1d2f4a5b6978877665544332211ffc3e1d2f4a5b6978877665544332211ff", signatureTier: "certified",
    signedCopyFileId: null,
    signatureProvider: "simulated", providerEnvelopeId: "simenv_00000000000000000000d001",
  },
];

// ── PV5-11: the SIMULATED PSrE's envelope for ctr-certified-retainer (review stage, PV-D43) ───────────────
const SIM_LABEL = "Simulated PSrE (review stage)";
const SIM_NOTICE = "Simulated certified signature: not a real PSrE signature";
type DemoSimSigner = {
  role: "client" | "countersigner"; displayName: string; state: "pending" | "signed";
  signerName: string | null; signerTitle: string | null; signedAt: string | null;
};
const SIM_SIGNERS: DemoSimSigner[] = [
  { role: "client", displayName: "Northwind Traders, authorised signatory", state: "pending", signerName: null, signerTitle: null, signedAt: null },
  { role: "countersigner", displayName: "Our company, authorised signatory", state: "pending", signerName: null, signerTitle: null, signedAt: null },
];
function simContract(): DemoContract {
  return CONTRACTS.find((k) => k.providerEnvelopeId && k.signatureProvider === "simulated") as DemoContract;
}
function simView(role: "client" | "countersigner", tenantPath: string) {
  const k = simContract();
  const slot = SIM_SIGNERS.find((x) => x.role === role) as DemoSimSigner;
  const completed = SIM_SIGNERS.every((x) => x.state === "signed");
  const canSign = slot.state === "pending" && !completed && k.status === "sent";
  return {
    envelopeId: k.providerEnvelopeId, provider: "simulated", label: SIM_LABEL, simulated: true, notice: SIM_NOTICE,
    title: `${k.title} (${k.reference})`, status: completed ? "completed" : "pending", completedAt: null,
    contractId: k.id, clientId: CLIENT_ID, contractStatus: k.status, contentSha256: k.contentSha256,
    documentFilename: `${k.reference}.md`, documentContentType: "text/markdown; charset=utf-8", documentSha256: k.contentSha256,
    documentText: k.bodyMd, documentPath: `${tenantPath}/simulated-psre/envelopes/${k.providerEnvelopeId}/document`,
    signers: SIM_SIGNERS.map((x) => ({ ...x })), yourRole: role, canSign,
    reason: canSign || slot.state === "signed" ? null : `this agreement is ${k.status} and cannot be signed`,
  };
}
function simSign(role: "client" | "countersigner", parsed: Record<string, unknown>): DemoResult {
  const k = simContract();
  if (parsed.agree !== true) return bad("you must confirm you agree to the terms", "agree");
  const signerName = String(parsed.signerName ?? "").trim();
  if (signerName.length < 2) return bad("signerName required", "signerName");
  if (String(parsed.documentSha256 ?? "").trim().toLowerCase() !== k.contentSha256) {
    return conflict("this document changed since you opened it; reload it and read it again before signing", "content_changed");
  }
  const slot = SIM_SIGNERS.find((x) => x.role === role) as DemoSimSigner;
  if (slot.state === "signed") return ok({ ok: true, simulated: true, outcome: "already_signed", completed: false, noticesDelivered: 0 });
  slot.state = "signed";
  slot.signerName = signerName;
  slot.signerTitle = parsed.signerTitle ? String(parsed.signerTitle) : null;
  slot.signedAt = new Date().toISOString();
  // What the ERP records after its re-fetch (the real path writes it from the provider's status, never from this call).
  k.signatures.push({ party: role === "client" ? "client" : "provider", signerName, signerTitle: slot.signerTitle, signedAt: slot.signedAt });
  const completed = SIM_SIGNERS.every((x) => x.state === "signed");
  if (completed) {
    k.status = "signed";
    k.signedAt = new Date().toISOString();
  }
  return ok({ ok: true, simulated: true, outcome: "signed", completed, noticesDelivered: completed ? 2 : 1 });
}

/** PV5-11: the STAFF side of the simulated PSrE (the countersigner's page) and the staff refresh, in DEMO_MODE. */
export function simulatedPsreStaffDemo(method: string, p: string, body?: string): DemoResult | null {
  const m = method.toUpperCase();
  const tenantPath = (p.match(/^(\/api\/[^/]+)\//) ?? [])[1];
  if (!tenantPath) return null;
  const k = simContract();
  const parsed: Record<string, unknown> = (() => {
    if (!body) return {};
    try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; }
  })();
  const env = p.match(/^\/api\/[^/]+\/simulated-psre\/envelopes\/([^/]+)(\/countersign|\/document)?$/);
  if (env) {
    if (env[1] !== k.providerEnvelopeId) return notFound("envelope not found");
    if (!env[2] && m === "GET") return ok(simView("countersigner", tenantPath));
    if (env[2] === "/countersign" && m === "POST") return simSign("countersigner", parsed);
    if (env[2] === "/document") return notFound("no stored content in demo mode");
  }
  if (/^\/api\/[^/]+\/contracts\/[^/]+\/certified-signing\/refresh$/.test(p) && m === "POST") {
    return ok({ status: "pending", outcome: "nothing new at the provider", contractStatus: k.status });
  }
  return null;
}

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

// ── PV4-08: conversation + shared meeting notes (BFF contract §29a, §29c) ──────────────────────────
//
// Same globalThis pinning as the change-request store above (the server-action graph and the page graph are bundled
// separately). The demo client identities are client-wide, so `canUseGeneral` is true. Messages are permanent (PV-D34):
// there is no edit and no retract, so the demo store has no `PATCH`/`DELETE` on a message (they answer 404, as the BFF does).
// Nothing here reproduces the staff side: a staff reply is not drivable in demo mode (the stub BFF's spec injects one).
interface DemoMessage {
  id: string; threadId: string; authorId: string; authorName: string; authorSide: "client" | "staff";
  body: string; createdAt: string;
  attachments: Array<{ id: string; filename: string; contentType: string; byteSize: number }>;
}
interface DemoThread {
  id: string; projectId: string | null; subject: string | null; status: "open" | "closed";
  createdSide: "client" | "staff"; createdAt: string; unread: number;
}
interface DemoMinutes {
  id: string; projectId: string | null; title: string; meetingDate: string; sharedAt: string; sharedBy: string; bodyMd: string;
}
const CONV_STORE_KEY = Symbol.for("gaiada.demoPortal.conversation");
const CONV = ((globalThis as Record<symbol, unknown>)[CONV_STORE_KEY] ??= {
  threads: [
    { id: "th-general", projectId: null, subject: null, status: "open", createdSide: "staff", createdAt: stamp(-12), unread: 0 },
    { id: "th-site", projectId: "proj-nw-site", subject: "Homepage copy", status: "open", createdSide: "client", createdAt: stamp(-5), unread: 1 },
    { id: "th-brand", projectId: "proj-nw-brand", subject: "Logo options", status: "closed", createdSide: "staff", createdAt: stamp(-9), unread: 0 },
  ] as DemoThread[],
  messages: [
    { id: "msg-g1", threadId: "th-general", authorId: "demo-staff-made", authorName: "Made Prabowo", authorSide: "staff", body: "Welcome to your portal. Ask us anything here; we reply within a working day.", createdAt: stamp(-12), attachments: [] },
    { id: "msg-g2", threadId: "th-general", authorId: "demo-client", authorName: "Dana Whitfield", authorSide: "client", body: "Thanks Made. Where do I find the invoices? See https://example.com/help.", createdAt: stamp(-11.5), attachments: [] },
    { id: "msg-s1", threadId: "th-site", authorId: "demo-client", authorName: "Dana Whitfield", authorSide: "client", body: "Can we change the homepage headline before Friday?", createdAt: stamp(-5), attachments: [{ id: "file-msg-s1", filename: "headline-options.pdf", contentType: "application/pdf", byteSize: 48_213 }] },
    { id: "msg-s2", threadId: "th-site", authorId: "demo-staff-made", authorName: "Made Prabowo", authorSide: "staff", body: "Yes. Send us the wording and we will have it live by Thursday.", createdAt: stamp(-4), attachments: [] },
    { id: "msg-b1", threadId: "th-brand", authorId: "demo-staff-made", authorName: "Made Prabowo", authorSide: "staff", body: "Three logo directions attached for review.", createdAt: stamp(-9), attachments: [] },
    { id: "msg-b2", threadId: "th-brand", authorId: "demo-client", authorName: "Dana Whitfield", authorSide: "client", body: "Option two, please. Thank you.", createdAt: stamp(-8), attachments: [] },
  ] as DemoMessage[],
  minutes: [
    { id: "min-kickoff", projectId: "proj-nw-site", title: "Website relaunch kickoff", meetingDate: stamp(-30), sharedAt: stamp(-29), sharedBy: "Made Prabowo",
      bodyMd: "## Decisions\n\n- Launch target is the end of next quarter\n- Two rounds of revisions per template\n\n## Actions\n\n- Northwind sends brand assets\n- We share the sitemap draft" },
    { id: "min-design", projectId: "proj-nw-site", title: "Design review", meetingDate: stamp(-10), sharedAt: stamp(-9), sharedBy: "Made Prabowo",
      bodyMd: "The homepage direction was **approved**. The product page needs a second pass." },
  ] as DemoMinutes[],
}) as { threads: DemoThread[]; messages: DemoMessage[]; minutes: DemoMinutes[] };

function convMessageView(m: DemoMessage, userId: string) {
  return {
    id: m.id, threadId: m.threadId, authorId: m.authorId, authorName: m.authorName, authorSide: m.authorSide,
    body: m.body, createdAt: m.createdAt,
    mine: m.authorId === userId && m.authorSide === "client", attachments: m.attachments,
  };
}
function convThreadView(t: DemoThread, withUnread: boolean) {
  const last = CONV.messages.filter((m) => m.threadId === t.id).map((m) => m.createdAt).sort().at(-1) ?? t.createdAt;
  const proj = t.projectId ? PROJECTS.find((x) => x.id === t.projectId) : null;
  return {
    id: t.id, clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: t.projectId, projectName: proj?.name ?? null,
    general: t.projectId === null, subject: t.subject, status: t.status, createdSide: t.createdSide,
    lastMessageAt: last, createdAt: t.createdAt, ...(withUnread ? { unreadCount: t.unread } : {}),
  };
}
const MB10 = 10 * 1024 * 1024;
/** The BFF's own write checks for a new message (§29): body 1..10,000, at most 5 files and 10 MB in total. */
function convCheckNew(parsed: Record<string, unknown>): { error: string; field: string } | { body: string; files: DemoMessage["attachments"] } {
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!body) return { error: "body is required", field: "body" };
  if (body.length > 10_000) return { error: "body too long (max 10,000 characters)", field: "body" };
  const atts = Array.isArray(parsed.attachments) ? (parsed.attachments as Array<{ filename?: string; contentType?: string; content?: string }>) : [];
  if (atts.length > 5) return { error: "too many attachments (max 5)", field: "attachments" };
  const sizes = atts.map((a) => Math.floor(String(a.content ?? "").length * 3 / 4));
  if (sizes.reduce((n, x) => n + x, 0) > MB10) return { error: "attachments too large (max 10 MB per message in total)", field: "attachments" };
  return { body, files: atts.map((a, i) => ({ id: nextId("file"), filename: String(a.filename ?? "file"), contentType: String(a.contentType ?? "application/octet-stream"), byteSize: sizes[i] })) };
}

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
/** The invoice-of-record fields, exactly as the BFF adds them (PV5-04, PV5-07). `payable`: issued, `sent`, and something
 *  still owed after the claims being verified. */
function recordFields(inv: DemoInvoice) {
  const paid = confirmedSum(inv.id);
  const outstanding = Math.round((inv.total - paid) * 100) / 100;
  return {
    invoiceNo: inv.invoiceNo, issueDate: inv.issueDate, dueDate: inv.dueDate, subtotal: inv.subtotal,
    taxTotal: inv.taxTotal, taxCode: inv.taxCode, issuer: DEMO_ISSUER, outstanding,
    payable: inv.status === "sent" && outstanding - pendingSum(inv.id) > 0, pdfFileId: inv.pdfFileId,
  };
}
/** PV5-10: the backend's online-payment decision, mirrored for the demo: an issued IDR invoice with something still owed
 *  after the claims being verified. The amount is that headroom. */
function onlinePaymentFlag(inv: DemoInvoice) {
  const headroom = Math.round((inv.total - confirmedSum(inv.id) - pendingSum(inv.id)) * 100) / 100;
  if (inv.status === "sent" && inv.currency === "IDR" && headroom > 0) return { available: true, amount: headroom, currency: inv.currency };
  if (inv.status === "paid" || inv.total - confirmedSum(inv.id) <= 0) {
    return { available: false, reason: "nothing_outstanding", message: "Nothing is left to pay on this invoice." };
  }
  return { available: false, reason: "payment_being_verified", message: "We're verifying a payment you told us about. Once that's done, any balance left can be paid online." };
}
function invoiceSummary(inv: DemoInvoice) {
  const paid = confirmedSum(inv.id);
  return {
    id: inv.id, status: inv.status, currency: inv.currency, total: inv.total,
    periodStart: inv.periodStart, periodEnd: inv.periodEnd, issuedAt: inv.issuedAt,
    clientName: inv.clientName, paid, pendingConfirmation: pendingSum(inv.id),
    balance: Math.round((inv.total - paid) * 100) / 100, overdue: isOverdue(inv),
    ...recordFields(inv),
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
    signedCopyFileId: k.signedCopyFileId,
    kind: k.kind ?? "agreement", amendsId: k.amendsId ?? null, amendsReference: k.amendsReference ?? null,
    changeRequestId: k.changeRequestId ?? null,
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
    // An UNDATED milestone, exactly as the live BFF sends one (`at: null`). Live 2026-10-11 this shape
    // crashed the timeline page; keeping one here puts that path under the portal e2e for good.
    {
      kind: "milestone" as const, id: "ms-nw-undated", label: "Content sign-off (date to be agreed)", status: "open",
      at: null as string | null, tense: "due" as const, context: "Northwind — website relaunch", projectId: "proj-nw-site",
    },
  ];
  // Newest first, undated last (null-safe: see splitTimeline in lib/portal.ts).
  return events.sort((a, b) => (a.at === null ? 1 : b.at === null ? -1 : b.at.localeCompare(a.at)));
}

// ── PV7-03: project health (BFF §54.5) ────────────────────────────────────────────────────────────
// Field names are the contract's, exactly. It is DERIVED from the stores above wherever they hold the fact (milestones,
// deliverables, unsigned agreements, the pending gate, recorded payments, the open conversation), so the Overview agrees
// with the Projects page, the timeline and the "Waiting for you" card in the same demo session.
//
// Per identity (follows `PORTAL_SCOPE` in demoClientCentre.ts):
//   demo-client         Northwind client-wide, AND Demo Harbour Hotel through ONE project only (the project-scoped
//                       contact: no client-wide items, `wide: false`, a turnaround counted on that project alone).
//   every other portal identity  Northwind client-wide only.
// What the payload never carries (internal gates, tasks, people, money, a state label) is not here either.
const HEALTH_SETTLED = ["delivered", "approved", "done"];
interface HealthBallItem { kind: string; id: string; context: string | null; since: string | null }
function healthBall(items: HealthBallItem[]) {
  const sorted = [...items].sort((a, b) => String(a.since).localeCompare(String(b.since)));
  return { count: sorted.length, oldestSince: sorted[0]?.since ?? null, items: sorted.slice(0, 25) };
}
/** Items for one scope: `projectId` for a project, `null` for the client-wide part (items with no project). */
function healthBalls(projectId: string | null) {
  const you: HealthBallItem[] = [];
  const us: HealthBallItem[] = [];
  if (projectId === "proj-nw-site") you.push({ kind: "gate", id: "gate-demo-2", context: "Northwind — website relaunch", since: stamp(-3) });
  for (const k of CONTRACTS) {
    if (k.status === "sent" && k.projectId === projectId && !k.signatures.some((x) => x.party === "client")) {
      you.push({ kind: "contract", id: k.id, context: k.title, since: k.sentAt });
    }
  }
  if (projectId === null) {
    // A recorded payment is the client's own, so it is client-wide, and its context is null (no amount, PV-D38).
    for (const list of Object.values(PAYMENTS)) {
      for (const pay of list) if (pay.status === "pending") us.push({ kind: "payment", id: pay.id, context: null, since: pay.recordedAt });
    }
  }
  // A thread whose last message is the client's is waiting for our reply.
  for (const t of CONV.threads) {
    if (t.status !== "open" || t.projectId !== projectId) continue;
    const msgs = CONV.messages.filter((x) => x.threadId === t.id);
    const last = msgs[msgs.length - 1];
    if (last && last.authorSide === "client") us.push({ kind: "conversation", id: t.id, context: t.subject ?? "General conversation", since: last.createdAt });
  }
  return { waitingOnYou: healthBall(you), waitingOnUs: healthBall(us) };
}
function northwindHealth() {
  const today = day(0);
  const projects = PROJECTS.map((pr) => {
    const ms = MILESTONES.filter((x) => x.projectId === pr.id);
    const dl = DELIVERABLES.filter((x) => x.projectId === pr.id);
    const open = ms.filter((x) => x.status !== "done");
    const next = open.filter((x) => x.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    return {
      projectId: pr.id, name: pr.name, status: pr.status,
      milestones: {
        total: ms.length, done: ms.length - open.length,
        upcoming: open.filter((x) => x.dueDate >= today).length, late: open.filter((x) => x.dueDate < today).length, undated: 0,
      },
      deliverables: {
        total: dl.length, delivered: dl.filter((x) => HEALTH_SETTLED.includes(x.status)).length,
        late: dl.filter((x) => x.dueDate < today && !HEALTH_SETTLED.includes(x.status)).length,
      },
      nextMilestone: next ? { id: next.id, name: next.name, dueDate: next.dueDate } : null,
      ...healthBalls(pr.id),
    };
  });
  return {
    clientId: CLIENT_ID, name: "Northwind Traders", wide: true, projects,
    clientWide: healthBalls(null),
    turnaround: { windowDays: 90 as const, client: { medianDays: 2.5, n: 7, withheld: false }, ours: { medianDays: 1.5, n: 9, withheld: false } },
  };
}
/** The project-scoped contact's client: one project, no client-wide part, and a turnaround from that project alone, so
 *  our side is below 3 samples and is withheld. */
function harbourHealth() {
  return {
    clientId: "cl-harbour", name: "Demo Harbour Hotel", wide: false,
    projects: [{
      projectId: "proj-hb-spa", name: "Spa booking page", status: "active",
      milestones: { total: 3, done: 1, upcoming: 2, late: 0, undated: 0 },
      deliverables: { total: 2, delivered: 1, late: 0 },
      nextMilestone: { id: "ms-hb-2", name: "Booking form live", dueDate: day(14) },
      waitingOnYou: healthBall([{ kind: "gate", id: "gate-hb-1", context: "Spa booking page", since: stamp(-6) }]),
      waitingOnUs: healthBall([]),
    }],
    clientWide: null,
    turnaround: { windowDays: 90 as const, client: { medianDays: 3, n: 4, withheld: false }, ours: { medianDays: null, n: 2, withheld: true } },
  };
}
function portalHealth(userId: string) {
  return {
    asOf: new Date().toISOString(),
    clients: userId === DEMO_CLIENT_USER ? [northwindHealth(), harbourHealth()] : [northwindHealth()],
    unavailable: [] as string[],
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────────────────────────

export function portalDashboardDemo(method: string, p: string, userId: string, body?: string): DemoResult | null {
  const m = method.toUpperCase();
  if (!/^\/api\/[^/]+\/portal\//.test(p)) return null;
  // Route table FIRST, identity check second — but only for routes this module owns, so unmatched
  // portal routes still fall through to `portalDemo` (runs/gates) rather than being 403'd here.
  const seg = p.replace(/^\/api\/[^/]+\/portal\//, "");
  const OWNED = /^(overview|projects|milestones|timeline|deliverables|invoices|contracts|documents|profile|stream|files|change-requests|conversation|meetings|payments|simulated-psre|health)(\/|\?|$)/;
  if (!OWNED.test(seg)) return null;
  if (!isDemoPortalClient(userId)) return { status: 403, json: { error: "not a portal client" } };

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
      conversationUnread: CONV.threads.filter((t) => t.unread > 0).length,
    });
  }

  // ── project health (PV7-03, BFF §54.5) ──
  if (seg === "health" && m === "GET") return ok(portalHealth(userId));

  // ── projects ──
  if (seg === "projects" && m === "GET") return ok(PROJECTS);
  const projM = seg.match(/^projects\/([^/]+)$/);
  if (projM && m === "GET") {
    const proj = PROJECTS.find((x) => x.id === projM[1]);
    if (!proj) return notFound("project not found");
    return ok({
      ...proj,
      lead: PROJECT_LEADS[proj.id] ?? null,
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

  // ── documents (PV5-08): signed agreements, issued-invoice PDFs, payment receipts; newest first ──
  if (seg === "documents" && m === "GET") {
    const items = [
      ...CONTRACTS.filter((k) => k.status === "signed" && k.signedAt).map((k) => ({
        id: k.id, kind: "signed_contract", title: k.title, date: k.signedAt as string, fileId: `file-sealed-${k.id}`, ready: true,
      })),
      ...INVOICES.map((inv) => ({
        id: inv.id, kind: "invoice", title: `Invoice ${inv.id.replace(/^inv-/, "").toUpperCase()}`, date: inv.issuedAt, fileId: `file-pdf-${inv.id}`, ready: true,
      })),
      ...Object.values(PAYMENTS).flat().filter((x) => x.proofFileId).map((x) => ({
        id: x.id, kind: "receipt", title: "Payment proof", date: x.paidOn, fileId: x.proofFileId, ready: true,
      })),
    ];
    return ok({ items: items.sort((x, y) => Date.parse(y.date) - Date.parse(x.date)) });
  }

  // ── invoices + payments ──
  if (seg === "invoices" && m === "GET") return ok(INVOICES.map(invoiceSummary));
  const invM = seg.match(/^invoices\/([^/]+)$/);
  if (invM && m === "GET") {
    const inv = INVOICES.find((x) => x.id === invM[1]);
    if (!inv) return notFound("invoice not found");
    const paid = confirmedSum(inv.id);
    const { taxRate, ...rest } = inv;
    return ok({
      ...rest, payments: paymentsOf(inv.id), paid, balance: Math.round((inv.total - paid) * 100) / 100,
      ...recordFields(inv),
      taxLines: inv.taxTotal != null && inv.taxCode ? [{ code: inv.taxCode, rate: taxRate, base: inv.subtotal, amount: inv.taxTotal }] : [],
      onlinePayment: onlinePaymentFlag(inv),
    });
  }
  // PV5-10: "Pay online". There is no provider in the demo, so the "hosted page" is the invoice's own return URL: the
  // flow (click, leave, come back to "We're confirming your payment") is drivable without leaving the app.
  const ckM = seg.match(/^invoices\/([^/]+)\/checkout$/);
  if (ckM && m === "POST") {
    const inv = INVOICES.find((x) => x.id === ckM[1]);
    if (!inv) return notFound("invoice not found");
    const flag = onlinePaymentFlag(inv);
    if (!flag.available) return conflict(flag.message ?? "online payment is not available", "reason" in flag ? String(flag.reason) : undefined);
    return ok({
      checkoutUrl: `/portal/invoices/${inv.id}?checkout=finished`, amount: String(flag.amount), currency: inv.currency,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reused: false,
    });
  }
  // PV-D41: the SIMULATED hosted payment page (review stage). One demo order on the open invoice, stateful per process.
  const simM = seg.match(/^payments\/simulated\/([^/]+?)(\/act)?$/);
  if (simM) {
    if (simM[1] !== DEMO_SIM_ORDER) return notFound("payment not found");
    const inv = INVOICES.find((x) => x.id === "inv-2026-014");
    if (!inv) return notFound("payment not found");
    const view = () => ({
      simulated: true, orderId: DEMO_SIM_ORDER, invoiceId: inv.id, invoiceNo: inv.invoiceNo, amount: inv.total - confirmedSum(inv.id),
      currency: inv.currency, transactionStatus: demoSimStatus, canAct: demoSimStatus === null || demoSimStatus === "pending",
      returnUrl: `/portal/invoices/${inv.id}?checkout=finished`,
    });
    if (!simM[2] && m === "GET") return ok(view());
    if (simM[2] && m === "POST") {
      const action = String(parsed.action ?? "");
      if (!["pay", "pending", "fail"].includes(action)) return bad("action must be pay|pending|fail", "action");
      if (!view().canAct) return conflict("this simulated payment is already final", "already_final");
      demoSimStatus = action === "pay" ? "settlement" : action === "pending" ? "pending" : "deny";
      return ok({ ok: true, simulated: true, transactionStatus: demoSimStatus, returnUrl: view().returnUrl });
    }
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
      kind: s.kind, amendsId: s.amendsId, amendsReference: s.amendsReference, changeRequestId: s.changeRequestId,
      canSign: k.status === "sent" && !s.clientSigned && !s.termEnded && k.signatureTier !== "certified",
      viewOnly: false,
      signatures: k.signatures.map((x) => ({ ...x, provider: k.signatureProvider ?? null })),
      contentSha256: k.contentSha256,
      signatureTier: k.signatureTier,
      signedCopyFileId: k.signedCopyFileId,
      // PV5-11: the certified-signing block (null for an attested contract), as the BFF computes it.
      signatureProvider: k.signatureProvider ?? null,
      providerEnvelopeId: k.providerEnvelopeId ?? null,
      certifiedSigning: k.signatureTier === "certified"
        ? {
            provider: "simulated", label: SIM_LABEL, simulated: true, available: true, envelopeStarted: !!k.providerEnvelopeId,
            canStart: k.status === "sent" && !s.clientSigned && !s.termEnded,
            signingUrl: k.status === "sent" && !s.clientSigned && !s.termEnded && k.providerEnvelopeId
              ? `/portal/simulated-psre/${k.providerEnvelopeId}` : null,
          }
        : null,
      document: k.fileId
        ? { id: k.fileId, filename: `${k.reference}.pdf`, contentType: "application/pdf", byteSize: 214_882, url: null }
        : null,
    });
  }
  // ── PV5-11: certified signing through the SIMULATED PSrE ──
  const certM = seg.match(/^contracts\/([^/]+)\/certified-signing(\/refresh)?$/);
  if (certM && m === "POST") {
    const k = CONTRACTS.find((x) => x.id === certM[1]);
    if (!k) return notFound("contract not found");
    if (certM[2]) return ok({ status: "pending", outcome: "nothing new at the provider", contractStatus: k.status });
    if (k.signatureTier !== "certified" || !k.providerEnvelopeId) {
      return conflict("this agreement is signed by typed name, not through a certified signing provider", "not_certified");
    }
    if (String(parsed.contentSha256 ?? "").trim().toLowerCase() !== k.contentSha256) {
      return conflict("this agreement changed since you opened it; reload it and read it again before signing", "content_changed");
    }
    return ok({ envelopeId: k.providerEnvelopeId, provider: "simulated", label: SIM_LABEL, simulated: true, signingUrl: `/portal/simulated-psre/${k.providerEnvelopeId}` });
  }
  const simEnvM = seg.match(/^simulated-psre\/envelopes\/([^/]+)(\/sign|\/document)?$/);
  if (simEnvM) {
    const k = simContract();
    if (simEnvM[1] !== k.providerEnvelopeId) return notFound("envelope not found");
    if (!simEnvM[2] && m === "GET") return ok(simView("client", p.replace(/\/simulated-psre\/.*$/, "")));
    if (simEnvM[2] === "/sign" && m === "POST") return simSign("client", parsed);
    if (simEnvM[2] === "/document") return notFound("no stored content in demo mode");
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
    // PV5-06: the client signs what they saw. An echo that differs from the hash fixed at send is refused with a 409 and
    // NOTHING is written, so the stale-page path is drivable in the browser. (The demo is lenient about a MISSING echo,
    // unlike the real route, which answers 400 `content_hash_required`: the unit tests post without one.)
    const echoed = String(parsed.contentSha256 ?? "").trim().toLowerCase();
    if (echoed && echoed !== k.contentSha256.toLowerCase()) {
      return {
        status: 409,
        json: { error: "this agreement changed since you opened it; reload it and read it again before signing", reason: "content_changed" },
      };
    }
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
    // WSK-49f: the contact rows and the caller's own grant come from the ONE website-access store
    // (lib/demoWebsiteAccess.ts), so the People page, the staff Contacts page and the grant state agree on
    // who is an admin, a signer or a viewer. Ids are USER ids, as in the real /portal/profile.
    const mine = portalCallerContact(userId);
    const contacts = portalProfileContacts().map((c) =>
      c.id === DEMO_CLIENT_USER ? { ...c, name: profileName } : c,
    );
    const self = contacts.find((c) => c.id === userId) ?? contacts.find((c) => c.id === DEMO_CLIENT_USER)!;
    const grantCap = mine?.capability ?? "signer";
    return ok({
      me: {
        id: self.id, name: self.id === DEMO_CLIENT_USER ? profileName : self.name, email: self.email,
        title: self.id === DEMO_CLIENT_USER ? profileTitle : null, memberSince: stamp(-400),
      },
      clients: [{
        id: CLIENT_ID, name: "Northwind Traders", status: "active", projectCount: PROJECTS.length,
        contact: { email: "accounts@northwind.example", phone: "+62 361 555 0134", address: "Jl. Raya Seminyak 12, Bali" },
        accountManager: { name: "Made Prabowo", email: "made@gaiada.example" },
      }],
      contacts,
      access: {
        // An admin implies signer (owner ruling 2026-10-11), as the real scope resolver's canSign does.
        canSign: grantCap === "signer" || grantCap === "admin",
        wholeClient: (mine?.projectId ?? null) === null,
        // PER CLIENT (2026-10-13): the demo has one client, so these are all-or-nothing.
        signerClientIds: grantCap === "signer" || grantCap === "admin" ? [CLIENT_ID] : [],
        wideClientIds: (mine?.projectId ?? null) === null ? [CLIENT_ID] : [],
        grants: [{ capability: grantCap, clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: mine?.projectId ?? null, projectName: null }],
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

  // ── conversation (PV4-03 / PV4-08, §29a) ──
  if (seg.startsWith("conversation?") || seg === "conversation") {
    if (m === "GET") {
      const pid = new URL(p, "http://demo").searchParams.get("projectId");
      const rows = CONV.threads.filter((t) => (pid ? t.projectId === pid : true))
        .map((t) => convThreadView(t, true))
        .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
      // PER CLIENT (2026-10-13): the demo has one client and its identities are client-wide on it.
      return ok({ threads: rows, canUseGeneral: true, generalClientIds: [CLIENT_ID] });
    }
    if (m === "POST") {
      const checked = convCheckNew(parsed);
      if ("error" in checked) return bad(checked.error, checked.field);
      const projectId = typeof parsed.projectId === "string" && parsed.projectId ? parsed.projectId : null;
      if (projectId && !PROJECTS.some((x) => x.id === projectId)) return notFound("project not found");
      let thread = projectId ? undefined : CONV.threads.find((t) => t.projectId === null);
      const createdNew = !thread;
      if (!thread) {
        thread = { id: nextId("th"), projectId, subject: parsed.subject ? String(parsed.subject).trim() || null : null, status: "open", createdSide: "client", createdAt: new Date().toISOString(), unread: 0 };
        CONV.threads.push(thread);
      }
      if (thread.status === "closed") return { status: 409, json: { error: "thread is closed" } };
      const id = nextId("msg");
      CONV.messages.push({ id, threadId: thread.id, authorId: userId, authorName: profileName, authorSide: "client", body: checked.body, createdAt: new Date().toISOString(), attachments: checked.files });
      return created({ threadId: thread.id, messageId: id, created: createdNew, attachmentIds: checked.files.map((f) => f.id) });
    }
  }
  // PV-D34: there is no edit and no retract route; the BFF answers 404 (no such route), so the demo does too.
  if (/^conversation\/messages\//.test(seg) && (m === "PATCH" || m === "DELETE")) return notFound("no such route");
  const thrM = seg.match(/^conversation\/([^/?]+)(\/messages)?$/);
  if (thrM) {
    const thread = CONV.threads.find((t) => t.id === thrM[1]);
    if (!thread) return notFound("conversation not found");
    if (!thrM[2] && m === "GET") {
      thread.unread = 0; // opening a thread marks it read
      return ok({
        thread: convThreadView(thread, false),
        messages: CONV.messages.filter((x) => x.threadId === thread.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((x) => convMessageView(x, userId)),
      });
    }
    if (thrM[2] && m === "POST") {
      if (thread.status === "closed") return { status: 409, json: { error: "thread is closed" } };
      const checked = convCheckNew(parsed);
      if ("error" in checked) return bad(checked.error, checked.field);
      const id = nextId("msg");
      const at = new Date().toISOString();
      CONV.messages.push({ id, threadId: thread.id, authorId: userId, authorName: profileName, authorSide: "client", body: checked.body, createdAt: at, attachments: checked.files });
      return created({ id, threadId: thread.id, createdAt: at, attachmentIds: checked.files.map((f) => f.id) });
    }
  }

  // ── shared meeting notes (PV4-05 / PV4-08, §29c) ──
  if (seg.startsWith("meetings") && m === "GET") {
    const strip = ({ projectId: _p, ...rest }: DemoMinutes) => rest;
    if (seg === "meetings" || seg.startsWith("meetings?")) {
      const pid = new URL(p, "http://demo").searchParams.get("projectId");
      return ok(CONV.minutes.filter((x) => (pid ? x.projectId === pid : true)).sort((a, b) => b.sharedAt.localeCompare(a.sharedAt)).map(strip));
    }
    const minM = seg.match(/^meetings\/([^/?]+)$/);
    const row = minM ? CONV.minutes.find((x) => x.id === minM[1]) : undefined;
    return row ? ok(strip(row)) : notFound("meeting minutes not found");
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
