import "server-only";
import { cache } from "react";
// PV5-07 — the data source of the two document print routes, `/print/invoices/[jobToken]` and
// `/print/contracts/[jobToken]`. The report-renderer sidecar's Chromium opens them with NO cookies; the only credential
// is the one-shot token in the URL, which platform-nest minted for exactly one document (core/document-render.ts).
//
// Same shape as TR-20's `reports-print-data.ts` (read its header): a session-less server-to-server GET of
// `/internal/documents/print-payload/:jobToken` on platform-nest, which BURNS the token on that one read. Every failure
// collapses to one DocumentPrintError; the page renders the same generic refusal for all of them.
//
// `cache()` matters: the token can be read once, so every caller inside one render must share the one fetch.
//
// The payload types are a CONTRACT with platform-nest `src/core/document-render.ts`; change both together. Money is a
// numeric STRING exactly as Postgres returned it; this side formats it and never computes with it.

export interface InvoicePrintPayload {
  kind: "invoice";
  renderNonce: string;
  invoice: {
    id: string;
    invoiceNo: string;
    status: string;
    issueDate: string;
    dueDate: string;
    periodStart: string | null;
    periodEnd: string | null;
    currency: string;
    minorUnit: number;
    subtotal: string;
    taxTotal: string;
    total: string;
    taxCode: string | null;
  };
  issuer: {
    legalName: string;
    address: string;
    npwp: string | null;
    isPkp: boolean | null;
    bank: { name: string; accountName: string; accountNo: string } | null;
  };
  client: { name: string };
  lines: Array<{
    lineNo: number;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    taxCode: string | null;
    taxRate: string | null;
    taxAmount: string;
  }>;
  taxLines: Array<{ code: string; rate: string | null; base: string; amount: string }>;
}

export interface ContractPrintSignature {
  party: "client" | "provider";
  signerName: string | null;
  signerTitle: string | null;
  signedAt: string;
  ipHash: string | null;
  userAgent: string | null;
  contentSha256: string | null;
}

export interface ContractPrintPayload {
  kind: "contract";
  renderNonce: string;
  includeBody: boolean;
  contract: {
    id: string;
    title: string;
    reference: string | null;
    version: number;
    kind: string | null;
    value: string | null;
    currency: string;
    startsOn: string | null;
    endsOn: string | null;
    sentAt: string | null;
    signedAt: string | null;
    contentSha256: string;
    contentFixedAt: string;
    signatureTier: string;
    bodyMd: string | null;
  };
  parties: { issuerLegalName: string; clientName: string };
  /** DW-10f-2a (BFF §61.9): the payment schedule FIXED AT SEND, with its own hash. Amounts are decimal strings, `due` is `"on_signing"` or
   *  `YYYY-MM-DD`. `null` (or absent, an older sealed payload) when the contract had none, and ALWAYS null for a schedule added after signing
   *  (DW-D49): nobody signed that one, so the sealed copy never prints it. */
  schedule?: {
    currency: string;
    total: string;
    sha256: string;
    instalments: { position: number; label: string; amount: string; due: string }[];
  } | null;
  document: { source: "attached_pdf" | "attached_file" | "body"; filename: string | null; sha256: string };
  signatures: ContractPrintSignature[];
  seal: {
    legalName: string;
    certificateSerial: string;
    certificateFingerprint: string;
    certificateValidTo: string;
    sealedAt: string;
  };
}

export type DocumentPrintPayload = InvoicePrintPayload | ContractPrintPayload;

export class DocumentPrintError extends Error {
  constructor(public reason: "missing" | "rejected" | "malformed" | "upstream_error", message: string) {
    super(message);
    this.name = "DocumentPrintError";
  }
}

function isPayload(v: unknown): v is DocumentPrintPayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (typeof p.renderNonce !== "string" || !p.renderNonce) return false;
  if (p.kind === "invoice") return !!p.invoice && !!p.issuer && Array.isArray(p.lines) && Array.isArray(p.taxLines);
  if (p.kind === "contract") return !!p.contract && !!p.parties && !!p.document && !!p.seal && Array.isArray(p.signatures);
  return false;
}

async function fetchDocumentPrintPayload(jobToken: string): Promise<DocumentPrintPayload> {
  if (!jobToken || !/^[A-Za-z0-9_-]{16,128}$/.test(jobToken)) throw new DocumentPrintError("missing", "no usable jobToken");
  const base = process.env.PLATFORM_URL;
  if (!base) throw new DocumentPrintError("upstream_error", "PLATFORM_URL is not configured");
  let res: Response;
  try {
    res = await fetch(`${base}/internal/documents/print-payload/${encodeURIComponent(jobToken)}`, { method: "GET", cache: "no-store" });
  } catch {
    throw new DocumentPrintError("upstream_error", "could not reach platform-nest");
  }
  if (!res.ok) throw new DocumentPrintError(res.status === 401 || res.status === 404 ? "rejected" : "upstream_error", `print payload: ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new DocumentPrintError("malformed", "print payload was not JSON");
  }
  if (!isPayload(body)) throw new DocumentPrintError("malformed", "print payload has the wrong shape");
  return body;
}

/** One fetch per token per render (React request memoization). */
export const getDocumentPrintPayload = cache(fetchDocumentPrintPayload);
