import "server-only";
// DEMO_MODE fixtures for PV3-08 — the staff Contracts & billing area (docs/FRONTEND-BFF-CONTRACT.md §16e).
//
// ONE stateful store of Northwind Traders' (`cl-1`) contracts and payment claims, read and written by:
//   GET   /api/:t/contracts[?clientId&status]          GET /api/:t/contracts/:id
//   POST  /api/:t/contracts                            PATCH /api/:t/contracts/:id      (draft edit, void)
//   POST  /api/:t/contracts/:id/send                   POST  /api/:t/contracts/:id/countersign
//   GET   /api/:t/invoice-payments[?clientId&status]   POST  /api/:t/invoice-payments/:id/decide
// and by the hub Overview fixture (`demoBillingNeedsUs` / `demoBillingNeedsClient`), so the Overview's
// items, the tab badge and this area can never disagree: deciding a payment here removes it from "waiting
// on us" there.
//
// It models the REAL controller's refusals, not a friendly subset (the point of a fixture that drives a
// browser test): authorize FIRST, and only then validate the body (an unauthorized caller with an empty
// body gets 403, never 400); a draft only is editable; a draft with neither terms nor file cannot be sent;
// a contract is Signed only when BOTH parties have signed, in either order; countersign is owner-only; a
// payment cannot be decided by whoever recorded it; a reject needs a reason; a repeat of any of these
// answers with the controller's own message.
//
// Who is who (see lib/demoIdentity.ts):
//   demo-hansel (platform_admin) and demo-owner (owner) may do everything, including countersign.
//   dept-manager (a manager) may read contracts only.
//   everyone else is refused every one of these routes (403 with the Cerbos denial text).
import type { DemoResult } from "./demoFixtures";

const CLIENT_ID = "cl-1";

type Status = "draft" | "sent" | "signed" | "declined" | "expired" | "void";
interface Signature { party: "client" | "provider"; signer: string | null; signerName: string; signerTitle: string | null; signedAt: string }
interface DemoContract {
  id: string; clientId: string; clientName: string; projectId: string | null; projectName: string | null;
  title: string; reference: string | null; version: number; status: Status; fileId: string | null; bodyMd: string | null;
  value: number | null; currency: string; startsOn: string | null; endsOn: string | null;
  sentAt: string | null; signedAt: string | null; declineReason: string | null; createdAt: string; signatures: Signature[];
}
interface DemoPayment {
  id: string; invoiceId: string; clientId: string; clientName: string; amount: number; currency: string; paidOn: string;
  method: string; reference: string | null; status: "pending" | "confirmed" | "rejected"; note: string | null;
  proofFileId: string | null; recordedBy: string; recordedAt: string; confirmedBy: string | null; confirmedAt: string | null;
  rejectedReason: string | null; invoiceTotal: number; invoiceStatus: string;
}

const daysAgo = (n: number): string => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString(); };
const dayOnly = (n: number): string => daysAgo(n).slice(0, 10);

// Lumen Studio (`cl-3`) carries its own contracts and payments so the billing e2e can drive the whole flow
// (draft, send, countersign, confirm) WITHOUT touching Northwind's items (the hub Overview spec asserts them
// by name) or Cedar Group's (cl-2 must stay empty: another spec asserts its empty state). The demo store is
// shared across parallel specs, so each spec needs a client of its own.
const LUMEN = { clientId: "cl-3", clientName: "Lumen Studio", projectId: null, projectName: null, version: 1, currency: "USD", startsOn: null, endsOn: null, declineReason: null };

const seedContracts = (): DemoContract[] => [
  { id: "dk-1", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: "p-web-1", projectName: "Website redesign", title: "Statement of Work: redesign", reference: "GDA-2026-014", version: 1, status: "sent", fileId: "f-1", bodyMd: null, value: 18000, currency: "USD", startsOn: dayOnly(30), endsOn: dayOnly(-120), sentAt: daysAgo(4), signedAt: null, declineReason: null, createdAt: daysAgo(6), signatures: [] },
  { id: "dk-2", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Master services agreement 2026", reference: "GDA-2026-020", version: 1, status: "draft", fileId: null, bodyMd: "## Master services agreement\n\nThe parties agree to the terms set out here.", value: null, currency: "USD", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdAt: daysAgo(2), signatures: [] },
  { id: "dk-3", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Hosting addendum", reference: null, version: 1, status: "draft", fileId: null, bodyMd: null, value: 1200, currency: "USD", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdAt: daysAgo(1), signatures: [] },
  { id: "dk-4", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Retainer agreement", reference: "GDA-2026-017", version: 1, status: "sent", fileId: null, bodyMd: "Monthly retainer, ninety days' notice.", value: 4000, currency: "USD", startsOn: dayOnly(14), endsOn: null, sentAt: daysAgo(9), signedAt: null, declineReason: null, createdAt: daysAgo(10),
    signatures: [{ party: "client", signer: "demo-client", signerName: "Dana Whitfield", signerTitle: "Head of Marketing", signedAt: daysAgo(3) }] },
  { id: "dk-5", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Mutual NDA", reference: "GDA-2026-009", version: 1, status: "signed", fileId: "f-1", bodyMd: null, value: null, currency: "USD", startsOn: null, endsOn: null, sentAt: daysAgo(40), signedAt: daysAgo(35), declineReason: null, createdAt: daysAgo(41),
    signatures: [
      { party: "client", signer: "demo-client", signerName: "Dana Whitfield", signerTitle: "Head of Marketing", signedAt: daysAgo(36) },
      { party: "provider", signer: "demo-owner", signerName: "Olive Owner", signerTitle: "Owner", signedAt: daysAgo(35) },
    ] },
  { id: "dk-6", clientId: CLIENT_ID, clientName: "Northwind Traders", projectId: null, projectName: null, title: "Pilot agreement (superseded)", reference: "GDA-2026-002", version: 1, status: "void", fileId: null, bodyMd: "Pilot terms.", value: 2500, currency: "USD", startsOn: null, endsOn: null, sentAt: daysAgo(80), signedAt: null, declineReason: null, createdAt: daysAgo(82), signatures: [] },
  { ...LUMEN, id: "dk-7", title: "Onboarding agreement", reference: "GDA-2026-031", status: "draft", fileId: null, bodyMd: "Onboarding terms.", value: 900, sentAt: null, signedAt: null, createdAt: daysAgo(1), signatures: [] },
  { ...LUMEN, id: "dk-8", title: "Retainer agreement", reference: "GDA-2026-029", status: "sent", fileId: null, bodyMd: "Monthly retainer.", value: 2000, sentAt: daysAgo(6), signedAt: null, createdAt: daysAgo(7),
    signatures: [{ party: "client", signer: "lumen-1", signerName: "Lena Lumen", signerTitle: "Director", signedAt: daysAgo(2) }] },
];

const seedPayments = (): DemoPayment[] => [
  { id: "dpay-1", invoiceId: "inv-1", clientId: CLIENT_ID, clientName: "Northwind Traders", amount: 2400, currency: "USD", paidOn: dayOnly(11), method: "bank_transfer", reference: "TRX-88231", status: "pending", note: "Part payment against the June invoice.", proofFileId: "f-2", recordedBy: "demo-client", recordedAt: daysAgo(11), confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent" },
  // Lumen Studio (`cl-3`), recorded by demo-hansel: when demo-hansel tries to confirm it, the controller's
  // maker-checker 403 shows. It sits on a DIFFERENT client from dpay-1 on purpose: the Northwind Overview then
  // has exactly one "Confirm a client-recorded payment" item (the hub e2e asserts that link is unique). The
  // invoice link points at `inv-1`, the one invoice the demo has, so the link opens something.
  { id: "dpay-2", invoiceId: "inv-1", clientId: "cl-3", clientName: "Lumen Studio", amount: 150, currency: "USD", paidOn: dayOnly(3), method: "cash", reference: null, status: "pending", note: null, proofFileId: null, recordedBy: "demo-hansel", recordedAt: daysAgo(3), confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent" },
  { id: "dpay-3", invoiceId: "inv-1", clientId: "cl-3", clientName: "Lumen Studio", amount: 300, currency: "USD", paidOn: dayOnly(2), method: "bank_transfer", reference: "LUM-1", status: "pending", note: null, proofFileId: null, recordedBy: "lumen-1", recordedAt: daysAgo(2), confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent" },
];

// Pinned on globalThis: the page, the layout and the server actions can land in different module instances
// under `next dev`, and they must all see ONE store.
const G = globalThis as unknown as { __demoBilling?: { contracts: DemoContract[]; payments: DemoPayment[]; seq: number } };
const store = () => (G.__demoBilling ??= { contracts: seedContracts(), payments: seedPayments(), seq: 100 });

/** Test hook: put the store back to its seed. */
export function resetDemoBilling(): void { G.__demoBilling = undefined; }

const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });
const deny = (action: string, kind: string): DemoResult => err(403, `not authorized: cerbos denied ${action} on ${kind}`);

const CONTRACT_READ = new Set(["demo-hansel", "demo-owner", "dept-manager"]);
const CONTRACT_WRITE = new Set(["demo-hansel", "demo-owner"]);
const COUNTERSIGN = new Set(["demo-hansel", "demo-owner"]);
const INVOICE_READ = new Set(["demo-hansel", "demo-owner", "dept-manager"]);
const INVOICE_UPDATE = new Set(["demo-hansel", "demo-owner"]);

// PV3-09 — `clientVisible`, by the backend's rule (BFF §22d; `portal-visibility.ts`): a contract is visible to
// the client when it has a client and is not a draft; a payment through its INVOICE (a draft invoice is not
// visible, anything else is, and a pending or rejected claim shows in the invoice's history too). Overview
// items use the same two functions, so the list, the detail and the Overview cannot disagree.
const contractVisible = (k: { clientId: string | null; status: string }): boolean => k.clientId != null && k.status !== "draft";
const paymentVisible = (x: { clientId: string | null; invoiceStatus: string }): boolean => x.clientId != null && x.invoiceStatus !== "draft";

/** A stand-in SHA-256 for a demo contract: 64 hex characters derived from its id. Not a real digest, and nothing checks it. */
const demoHash = (id: string): string => {
  let hex = "";
  for (let i = 0; hex.length < 64; i++) hex += (id.charCodeAt(i % id.length) * 7 + i * 13).toString(16).padStart(2, "0");
  return hex.slice(0, 64);
};

/** The contract as the list serves it: no `signatures`, plus the derived flags. */
function row(k: DemoContract, userId: string) {
  const { signatures, ...rest } = k;
  const clientSigned = signatures.some((s) => s.party === "client");
  const providerSigned = signatures.some((s) => s.party === "provider");
  // PV5-06: sending FIXES the content (the hash and the tier); a draft has neither. PV5-07: the sealed signed copy
  // exists only for dk-5 here, so every other signed contract (including one signed in a session) reads "being prepared".
  const fixed = k.sentAt != null;
  return {
    ...rest, supersedesId: null, createdBy: "demo-hansel", clientSigned, providerSigned,
    signatureTier: fixed ? "attested" : null, contentSha256: fixed ? demoHash(k.id) : null,
    contentFixedAt: fixed ? k.sentAt : null, certifiedRequested: false,
    signedCopyFileId: k.id === "dk-5" ? "f-signed-dk5" : null,
    termEnded: Boolean(k.endsOn && k.endsOn < dayOnly(0)),
    clientVisible: contractVisible(k),
    // PV3-01: one decision per caller, true only for a sent row still waiting on us.
    canCountersign: COUNTERSIGN.has(userId) && k.status === "sent" && !providerSigned,
  };
}

/** Hub Overview, "waiting on us": drafts we have not sent, and payments nobody has confirmed. */
export function demoBillingNeedsUs(clientId: string): { kind: "payment" | "contract"; id: string; label: string; context: string; href: string; since: string; clientVisible: boolean }[] {
  const s = store();
  const href = `/clients/${clientId}/billing`;
  return [
    ...s.payments.filter((p) => p.clientId === clientId && p.status === "pending").map((p) => ({
      kind: "payment" as const, id: p.id, label: "Confirm a client-recorded payment", context: `${p.currency} ${p.amount.toLocaleString("en-US")}`, href, since: p.recordedAt, clientVisible: paymentVisible(p),
    })),
    ...s.contracts.filter((k) => k.clientId === clientId && k.status === "draft").map((k) => ({
      kind: "contract" as const, id: k.id, label: "Send a drafted agreement", context: k.title, href, since: k.createdAt, clientVisible: contractVisible(k),
    })),
  ];
}

/** Hub Overview, "waiting on the client": contracts sent and not yet signed by them. */
export function demoBillingNeedsClient(clientId: string): { kind: "contract"; id: string; label: string; context: string; href: string; since: string; clientVisible: boolean }[] {
  return store().contracts
    .filter((k) => k.clientId === clientId && k.status === "sent" && !k.signatures.some((s) => s.party === "client"))
    .map((k) => ({ kind: "contract" as const, id: k.id, label: "Awaiting client signature", context: k.title, href: `/clients/${clientId}/billing`, since: k.sentAt ?? k.createdAt, clientVisible: contractVisible(k) }));
}

export function demoBillingPendingTotal(clientId: string): number {
  return store().payments.filter((p) => p.clientId === clientId && p.status === "pending").reduce((n, p) => n + p.amount, 0);
}

export function billingDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();
  const s = store();
  let hit: RegExpMatchArray | null;

  // ── documents (PV5-08, BFF §30b): signed agreements and payment proofs of one client, newest first ──
  if ((hit = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/documents$/)) && m === "GET") {
    if (!CONTRACT_READ.has(userId)) return deny("read", "client");
    const cid = hit[1];
    const items = [
      ...s.contracts.filter((k) => k.clientId === cid && k.status === "signed").map((k) => ({
        id: k.id, kind: "signed_contract", title: k.title, date: k.signedAt ?? k.createdAt,
        fileId: k.id === "dk-5" ? "f-signed-dk5" : k.fileId, ready: k.id === "dk-5", clientVisible: contractVisible(k),
      })),
      ...s.payments.filter((x) => x.clientId === cid && x.proofFileId).map((x) => ({
        id: x.id, kind: "receipt", title: "Payment proof", date: x.paidOn, fileId: x.proofFileId, ready: true, clientVisible: paymentVisible(x),
      })),
    ];
    return ok({ items: items.sort((x, y) => Date.parse(y.date) - Date.parse(x.date)) });
  }

  // ── payments ────────────────────────────────────────────────────────────────────────────────
  if ((hit = p.match(/^\/api\/[^/]+\/invoice-payments$/)) && m === "GET") {
    if (!INVOICE_READ.has(userId)) return deny("read", "invoice");
    const cid = params.get("clientId"), st = params.get("status");
    let rows = s.payments.filter((x) => (!st || x.status === st));
    if (cid) rows = cid.toLowerCase() === "internal" ? [] : rows.filter((x) => x.clientId === cid);
    return ok([...rows].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending")).map((x) => ({ ...x, clientVisible: paymentVisible(x) })));
  }
  if ((hit = p.match(/^\/api\/[^/]+\/invoice-payments\/([^/]+)\/decide$/)) && m === "POST") {
    // Authorize BEFORE validating (PV3-06): a caller who may not decide gets 403 whatever they sent.
    if (!INVOICE_UPDATE.has(userId)) return deny("update", "invoice");
    const b = JSON.parse(body || "{}") as { decision?: string; reason?: string };
    if (b.decision !== "confirm" && b.decision !== "reject") return err(400, "decision must be confirm|reject");
    if (b.decision === "reject" && !(b.reason ?? "").trim()) return err(400, "a reason is required when rejecting a payment");
    const pay = s.payments.find((x) => x.id === hit![1]);
    if (!pay) return err(404, "payment not found");
    if (pay.status !== "pending") return err(400, `this payment is already ${pay.status}`);
    if (pay.recordedBy === userId) return err(403, "a payment must be confirmed by someone other than whoever recorded it");
    pay.status = b.decision === "confirm" ? "confirmed" : "rejected";
    pay.confirmedBy = userId; pay.confirmedAt = new Date().toISOString();
    if (b.decision === "reject") pay.rejectedReason = (b.reason ?? "").trim();
    const paid = b.decision === "confirm" && pay.amount >= pay.invoiceTotal - 1;
    return ok({ ok: true, decision: b.decision, invoicePaid: paid });
  }

  // ── contracts ───────────────────────────────────────────────────────────────────────────────
  if ((hit = p.match(/^\/api\/[^/]+\/contracts$/))) {
    if (m === "GET") {
      if (!CONTRACT_READ.has(userId)) return deny("read", "contract");
      const cid = params.get("clientId"), st = params.get("status");
      let rows = s.contracts.filter((k) => !st || k.status === st);
      if (cid) rows = cid.toLowerCase() === "internal" ? [] : rows.filter((k) => k.clientId === cid);
      return ok(rows.map((k) => row(k, userId)));
    }
    if (m === "POST") {
      // Authorize BEFORE validating (PV3-06), as on the other writes.
      if (!CONTRACT_WRITE.has(userId)) return deny("create", "contract");
      const b = JSON.parse(body || "{}") as Record<string, unknown>;
      if (!b.clientId || !b.title) return err(400, "clientId and title required");
      if (b.value != null && !(Number.isFinite(Number(b.value)) && Number(b.value) >= 0)) return err(400, "value must be a non-negative number");
      if (b.startsOn && b.endsOn && String(b.endsOn) < String(b.startsOn)) return err(400, "endsOn cannot be before startsOn");
      const reference = b.reference ? String(b.reference).slice(0, 100) : null;
      if (reference) {
        const dup = s.contracts.find((k) => k.reference === reference && k.version === 1);
        if (dup) return dup.clientId === b.clientId ? { status: 201, json: { id: dup.id, status: dup.status, deduped: true } } : err(409, "that reference is already used by another contract");
      }
      const id = `dk-${++s.seq}`;
      s.contracts.unshift({
        id, clientId: String(b.clientId), clientName: String(b.clientId) === "cl-3" ? "Lumen Studio" : "Northwind Traders", projectId: (b.projectId as string) ?? null,
        projectName: b.projectId ? "Website redesign" : null, title: String(b.title).slice(0, 300), reference, version: 1, status: "draft",
        fileId: (b.fileId as string) ?? null, bodyMd: (b.bodyMd as string) ?? null, value: b.value == null ? null : Number(b.value),
        currency: String(b.currency || "USD").slice(0, 8), startsOn: (b.startsOn as string) ?? null, endsOn: (b.endsOn as string) ?? null,
        sentAt: null, signedAt: null, declineReason: null, createdAt: new Date().toISOString(), signatures: [],
      });
      return { status: 201, json: { id, status: "draft" } };
    }
    return null;
  }

  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)$/))) {
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (m === "GET") {
      if (!CONTRACT_READ.has(userId)) return deny("read", "contract");
      if (!k) return err(404, "contract not found");
      return ok({ ...row(k, userId), signatures: k.signatures });
    }
    if (m === "PATCH") {
      if (!CONTRACT_WRITE.has(userId)) return deny("update", "contract");
      if (!k) return err(404, "contract not found");
      const b = JSON.parse(body || "{}") as Record<string, unknown>;
      const voiding = b.status === "void";
      if (k.status !== "draft" && !voiding) return err(400, `a ${k.status} contract cannot be edited — issue a new version with supersedesId instead`);
      if (b.status && b.status !== "void" && b.status !== "draft") return err(400, "status here may only be set to void; use /send to issue");
      if (voiding) { k.status = "void"; return ok({ ok: true }); }
      if (typeof b.title === "string" && b.title) k.title = b.title.slice(0, 300);
      if (typeof b.reference === "string" && b.reference) k.reference = b.reference.slice(0, 100);
      if (typeof b.bodyMd === "string") k.bodyMd = b.bodyMd;
      if (typeof b.fileId === "string") k.fileId = b.fileId;
      if (b.value != null) k.value = Number(b.value);
      if (typeof b.currency === "string" && b.currency) k.currency = b.currency;
      if (typeof b.startsOn === "string" && b.startsOn) k.startsOn = b.startsOn;
      if (typeof b.endsOn === "string" && b.endsOn) k.endsOn = b.endsOn;
      return ok({ ok: true });
    }
    return null;
  }

  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/send$/)) && m === "POST") {
    if (!CONTRACT_WRITE.has(userId)) return deny("send", "contract");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return err(404, "contract not found");
    if (k.status !== "draft") return err(400, `this contract is already ${k.status}`);
    if (!k.fileId && !k.bodyMd) return err(400, "attach a document or write the terms before sending");
    k.status = "sent"; k.sentAt = new Date().toISOString();
    return ok({ ok: true, status: "sent", notified: 2 });
  }

  // PV5-06/PV-D25: certified signing is parked, so marking a draft certified is refused and writes nothing.
  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/mark-certified$/)) && m === "POST") {
    if (!CONTRACT_WRITE.has(userId)) return deny("mark_certified", "contract");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return err(404, "contract not found");
    if (k.status !== "draft") return err(400, "only a draft can be marked certified");
    return { status: 409, json: { error: "no certified signing provider is set up", reason: "no_certified_provider" } };
  }

  if ((hit = p.match(/^\/api\/[^/]+\/contracts\/([^/]+)\/countersign$/)) && m === "POST") {
    // Authorize BEFORE validating (PV3-06): a company_admin with an empty body gets 403, not 400.
    if (!COUNTERSIGN.has(userId)) return deny("countersign", "contract");
    const b = JSON.parse(body || "{}") as { signerName?: string; signerTitle?: string };
    const signerName = (b.signerName ?? "").trim();
    if (signerName.length < 2) return err(400, "signerName required");
    const k = s.contracts.find((x) => x.id === hit![1]);
    if (!k) return err(404, "contract not found");
    if (k.signatures.some((x) => x.party === "provider")) return ok({ ok: true, complete: k.status === "signed", alreadySigned: true });
    if (k.status !== "sent") return err(400, `a ${k.status} contract cannot be countersigned`);
    k.signatures.push({ party: "provider", signer: userId, signerName, signerTitle: b.signerTitle?.trim() || null, signedAt: new Date().toISOString() });
    const complete = k.signatures.some((x) => x.party === "client");
    if (complete) { k.status = "signed"; k.signedAt = new Date().toISOString(); }
    return ok({ ok: true, complete, alreadySigned: false });
  }

  return null;
}
