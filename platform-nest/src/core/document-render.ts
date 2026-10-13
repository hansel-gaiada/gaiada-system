// PV5-07 — rendering an issued invoice and a signed contract's evidence through `report-renderer`, with the TR-21
// one-shot job token pattern (modules/reports/report-pdf-export.ts is the precedent; read its header).
//
// The flow, per document:
//   1. platform-nest builds the WHOLE print payload from the database (never from a request: nothing a client or a staff
//      member typed into a request reaches the PDF except what is already stored on the row) and stores it in Redis
//      under a fresh 144-bit token (18 random bytes), 5-minute TTL;
//   2. it asks the sidecar to render `PLATFORM_UI_INTERNAL_URL + /print/{invoices|contracts}/{token}`;
//   3. that print page (platform-ui, outside the app shell, no session) fetches
//      `GET /internal/documents/print-payload/{token}` ONCE: the route GETDELs the token, so a replay gets 401;
//   4. the page sets `document.title` to the payload's random `renderNonce`, and Chromium copies it into the PDF's
//      /Title. The job refuses any PDF whose /Title is not that nonce. This matters because the sidecar renders whatever
//      the page shows: a refusal page, an error page or a half-loaded page would otherwise come back as a perfectly good
//      PDF and be stored, or sealed, as the document of record.
//
// The payload shapes below are a CONTRACT with platform-ui (`src/lib/documents-print-data.ts`); change both together.
import { randomBytes } from "node:crypto";
import { getRedis } from "../events/redis";
import { config } from "../config";
import { generateJobToken, PdfRendererNotConfiguredError, renderPrintPathViaSidecar } from "../modules/reports/report-pdf-export";
import { readPdfTitle } from "./document-seal";

/** Same lifetime as a report's print token (§6.3). */
export const DOCUMENT_PRINT_TOKEN_TTL_SECONDS = 5 * 60;
export const DOCUMENT_PRINT_KEY_PREFIX = "documents:printjob:";
export const documentPrintKey = (token: string): string => `${DOCUMENT_PRINT_KEY_PREFIX}${token}`;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Payloads (contract with platform-ui/src/lib/documents-print-data.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Money travels as numeric STRINGS (as Postgres returns them); the page formats them, it never computes them. */
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
    /** Decimal places of the currency (IDR 0). */
    minorUnit: number;
    subtotal: string;
    taxTotal: string;
    total: string;
    taxCode: string | null;
  };
  /** The issuer block FROZEN onto the invoice at issue (decision 5), never the billing profile as it is today. */
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
  /** Salted hash of the signer's IP (never the address itself). */
  ipHash: string | null;
  userAgent: string | null;
  /** The content hash this signature was made over. */
  contentSha256: string | null;
}

export interface ContractPrintPayload {
  kind: "contract";
  renderNonce: string;
  /** true when the agreement is the in-ERP body (rendered before the evidence page); false when it is an attached file
   *  (its pages, or the embedded file, come first and the print page renders only the evidence). */
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
  /** What the content hash covers. */
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

export function newRenderNonce(): string {
  return `render-${randomBytes(18).toString("base64url")}`;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Token mint / burn
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Store a fully built payload under a fresh one-shot token. The caller has already decided this document may be
 *  rendered (it is the platform's own job, not a request); the token can yield exactly this payload, once. */
export async function mintDocumentPrintToken(payload: DocumentPrintPayload): Promise<string> {
  const token = generateJobToken();
  await getRedis().set(documentPrintKey(token), JSON.stringify(payload), "EX", DOCUMENT_PRINT_TOKEN_TTL_SECONDS);
  return token;
}

/** Validate-and-burn (GETDEL). Unknown, expired and already-used tokens are the same `null`. */
export async function burnDocumentPrintToken(token: string): Promise<DocumentPrintPayload | null> {
  if (!token || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const raw = await getRedis().getdel(documentPrintKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DocumentPrintPayload;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Rendering
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type DocumentRenderReason = "renderer_not_configured" | "render_failed" | "render_unverified";

export class DocumentRenderError extends Error {
  constructor(public readonly reason: DocumentRenderReason, message: string) {
    super(message);
    this.name = "DocumentRenderError";
  }
}

/** Turns a print path into PDF bytes. The default is the report-renderer sidecar; tests install a stand-in that plays
 *  Chromium's part (fetches the payload through the real internal route and lays it out). */
export type PrintPathRenderer = (printPath: string, footerText?: string) => Promise<Buffer>;

const sidecarRenderer: PrintPathRenderer = (printPath, footerText) =>
  renderPrintPathViaSidecar(printPath, {
    rendererUrl: config.reportRenderer.url,
    rendererToken: config.reportRenderer.token,
    platformUiInternalUrl: config.reportRenderer.platformUiInternalUrl,
    timeoutMs: config.reportRenderer.timeoutMs,
    footerText,
  });

let renderer: PrintPathRenderer = sidecarRenderer;
/** Tests only. `null` restores the sidecar. */
export function setDocumentRendererForTest(r: PrintPathRenderer | null): void {
  renderer = r ?? sidecarRenderer;
}
const usingSidecar = (): boolean => renderer === sidecarRenderer;

/** The PDF footer: the issuer's legal name and the document number (invoice number, or the contract reference). */
export function documentFooterText(payload: DocumentPrintPayload): string {
  const parts =
    payload.kind === "invoice"
      ? [payload.issuer.legalName, payload.invoice.invoiceNo]
      : [payload.parties.issuerLegalName, payload.contract.reference];
  return parts.filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" - ");
}

/** Is there anything to render with? (Checked before any work, so a box with no renderer records one clear reason.) */
export function documentRendererConfigured(): boolean {
  if (!usingSidecar()) return true;
  const r = config.reportRenderer;
  return !!(r.url && r.token && r.platformUiInternalUrl && config.redisUrl);
}

/**
 * Render one document. Returns the PDF only if it is provably the page that rendered THIS payload (its /Title is the
 * payload's nonce). Throws DocumentRenderError otherwise. The token is deleted afterwards whether or not the page used
 * it, so an unused token never outlives the attempt.
 */
export async function renderDocumentPdf(payload: DocumentPrintPayload): Promise<Buffer> {
  if (!documentRendererConfigured()) {
    throw new DocumentRenderError("renderer_not_configured", "the PDF renderer is not configured (REPORT_RENDERER_URL / RENDERER_TOKEN / PLATFORM_UI_INTERNAL_URL / REDIS_URL)");
  }
  let token: string;
  try {
    token = await mintDocumentPrintToken(payload);
  } catch (e) {
    throw new DocumentRenderError("render_failed", `could not store the print job: ${(e as Error).message}`);
  }
  const path = `/print/${payload.kind === "invoice" ? "invoices" : "contracts"}/${token}`;
  try {
    let bytes: Buffer;
    try {
      bytes = await renderer(path, documentFooterText(payload));
    } catch (e) {
      if (e instanceof PdfRendererNotConfiguredError) throw new DocumentRenderError("renderer_not_configured", e.message);
      throw new DocumentRenderError("render_failed", `the renderer failed: ${(e as Error).message}`);
    }
    let title: string | undefined;
    try {
      title = await readPdfTitle(bytes);
    } catch {
      throw new DocumentRenderError("render_unverified", "the renderer did not return a readable PDF");
    }
    if (title !== payload.renderNonce) {
      throw new DocumentRenderError("render_unverified", "the rendered PDF is not the page for this document (refusal or error page)");
    }
    return bytes;
  } finally {
    await getRedis().del(documentPrintKey(token)).catch(() => undefined);
  }
}
