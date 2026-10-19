"use server";
// PV3-08 — the writes behind `/clients/[id]/billing` (BFF §16e). One shape for all of them, the same
// `{ ok, error?, field?, id? }` result every other actions file returns.
//
//   createContractAction     POST  /contracts, then (optional PDF) POST /files + PATCH /contracts/:id {fileId}
//   updateContractAction     PATCH /contracts/:id            (a draft only; the backend refuses anything else)
//   sendContractAction       POST  /contracts/:id/send       (draft -> sent, notifies the client's portal contacts)
//   voidContractAction       PATCH /contracts/:id {status:"void"}
//   countersignContractAction POST /contracts/:id/countersign
//   decidePaymentAction      POST  /invoice-payments/:id/decide   (client hub, and Finance's queue on Receivables: no clientId there)
//   saveScheduleAction       PUT   /contracts/:id/schedule                   (DW-10f-2b, BFF §61.4: a DRAFT's whole schedule)
//   addScheduleAfterSigningAction POST /contracts/:id/schedule/after-signing (DW-10f-2b, DW-D49, BFF §61.4a: once, signed contracts)
//
// ── NO CAPABILITY GATE HERE, AND WHY ─────────────────────────────────────────────────────────────
// `lib/rbac.ts` has no contract or payment-decision capability, and inventing a mirror would be a second,
// drifting copy of resource_contract.yaml (countersign is owner-only, send is company_admin, decide rides on
// `invoice` update). Cerbos is the authority and the server's refusal is shown in words. What the page DOES
// gate in the browser is only what the backend itself reported: the Countersign control exists only for a
// row whose `canCountersign` is true.
//
// ── THE PDF ──────────────────────────────────────────────────────────────────────────────────────
// The files route authorizes against its TARGET, so a contract's file can only be uploaded once the
// contract exists: create the draft first, upload with `entityType: "contract"`, then attach by `fileId`.
// That is two writes, and the failure to guard is the second one failing after the first landed: the
// result then says the DRAFT WAS SAVED and the file was not, instead of reporting a plain failure that
// would make the person create it again and leave a duplicate. The size is checked before anything is
// created, so the common failure (too big) leaves nothing behind.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can, isElevated } from "./rbac";
import {
  MAX_CONTRACT_FILE_BYTES, countersignErrorText, decideErrorText, validateContractForm, paymentDecisionState,
  markCertifiedErrorText, scheduleBody, scheduleErrorText, validateScheduleRows, type ContractSchedule, type ScheduleDraftRow,
} from "./contracts";
import { simulatedSignErrorText } from "./simulatedPsre";

export interface BillingActionState {
  ok: boolean;
  error?: string;
  field?: string;
  /** The contract id, when one was created or touched. */
  id?: string;
  /** A note that is not an error: e.g. "sent, 2 contacts notified". */
  notice?: string;
}

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

function fail(e: unknown, text?: (status: number | null, message: string) => string): BillingActionState {
  if (e instanceof PlatformError) {
    const message = text ? text(e.status, e.message) : e.message;
    return { ok: false, error: message, ...(e.field ? { field: e.field } : {}) };
  }
  throw e;
}

/** A refusal of a schedule route or of Send, in a sentence: branches on the server's `reason`, never on its message, and reads
 *  the figures of `schedule_total_mismatch` from the raw body's `detail` (BFF §61.17 "Refusal shape"). */
function failSchedule(e: unknown, currency: string): BillingActionState {
  if (e instanceof PlatformError) {
    const detail = (e.body as { detail?: { value?: number; total?: number } } | undefined)?.detail ?? null;
    return { ok: false, error: scheduleErrorText(e.status, e.reason, e.message, detail, currency), ...(e.field ? { field: e.field } : {}) };
  }
  throw e;
}

/** Refresh the page AND the hub layout: the tab badge lives in the layout. */
function refresh(clientId: string): void {
  revalidatePath(`/clients/${clientId}/billing`);
  revalidatePath(`/clients/${clientId}`, "layout");
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** The fields the draft form owns, as the backend's body. Blank optional fields are omitted (create) or
 *  left alone (update): the PATCH treats an absent field as "keep", so a blank cannot be sent to clear one. */
function draftBody(fd: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { if (v !== "" && v !== undefined && v !== null) body[k] = v; };
  set("title", str(fd, "title"));
  set("reference", str(fd, "reference"));
  set("projectId", str(fd, "projectId"));
  set("bodyMd", String(fd.get("bodyMd") ?? "").trim());
  set("currency", str(fd, "currency").toUpperCase());
  set("startsOn", str(fd, "startsOn"));
  set("endsOn", str(fd, "endsOn"));
  const value = str(fd, "value");
  if (value !== "") body.value = Number(value);
  return body;
}

/** Read the optional PDF. `instanceof File` and `size > 0`: an empty file input still yields a zero-byte File. */
async function readPdf(fd: FormData): Promise<{ filename: string; contentType: string; content: string } | { error: string } | null> {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_CONTRACT_FILE_BYTES) return { error: "That file is larger than 10 MB." };
  const buf = Buffer.from(await file.arrayBuffer());
  return { filename: file.name || "contract.pdf", contentType: file.type || "application/pdf", content: buf.toString("base64") };
}

async function attachPdf(
  c: { userId: string; tenant: string }, contractId: string, pdf: { filename: string; contentType: string; content: string },
): Promise<void> {
  const up = await platformFetch<{ id: string }>(`/api/${c.tenant}/files`, c.userId, {
    method: "POST",
    body: JSON.stringify({ entityType: "contract", entityId: contractId, filename: pdf.filename, content_type: pdf.contentType, content: pdf.content }),
  });
  await platformFetch(`/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}`, c.userId, {
    method: "PATCH", body: JSON.stringify({ fileId: up.id }),
  });
}

export async function createContractAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  if (!clientId) return { ok: false, error: "Missing client." };
  const bad = validateContractForm({ title: str(formData, "title"), value: str(formData, "value"), startsOn: str(formData, "startsOn"), endsOn: str(formData, "endsOn") });
  if (bad) return { ok: false, error: bad.message, field: bad.field };
  const pdf = await readPdf(formData);
  if (pdf && "error" in pdf) return { ok: false, error: pdf.error, field: "file" };

  let id: string;
  try {
    id = (await platformFetch<{ id: string }>(`/api/${c.tenant}/contracts`, c.userId, {
      method: "POST", body: JSON.stringify({ clientId, ...draftBody(formData) }),
    })).id;
  } catch (e) { return fail(e); }

  if (pdf) {
    try { await attachPdf(c, id, pdf); } catch (e) {
      refresh(clientId);
      const why = e instanceof PlatformError ? e.message : "an unexpected error";
      return { ok: false, id, error: `The draft was saved, but the PDF could not be attached (${why}). Open the draft and attach it again.`, field: "file" };
    }
  }
  refresh(clientId);
  return { ok: true, id };
}

export async function updateContractAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  if (!clientId || !contractId) return { ok: false, error: "Missing contract." };
  const bad = validateContractForm({ title: str(formData, "title"), value: str(formData, "value"), startsOn: str(formData, "startsOn"), endsOn: str(formData, "endsOn") });
  if (bad) return { ok: false, error: bad.message, field: bad.field };
  const pdf = await readPdf(formData);
  if (pdf && "error" in pdf) return { ok: false, error: pdf.error, field: "file" };

  const body = draftBody(formData);
  delete body.projectId; // the project is fixed when the draft is created; the PATCH has no such field
  try {
    await platformFetch(`/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}`, c.userId, { method: "PATCH", body: JSON.stringify(body) });
  } catch (e) { return fail(e); }
  if (pdf) {
    try { await attachPdf(c, contractId, pdf); } catch (e) {
      refresh(clientId);
      const why = e instanceof PlatformError ? e.message : "an unexpected error";
      return { ok: false, id: contractId, error: `The changes were saved, but the PDF could not be attached (${why}).`, field: "file" };
    }
  }
  refresh(clientId);
  return { ok: true, id: contractId };
}

export async function sendContractAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  if (!clientId || !contractId) return { ok: false, error: "Missing contract." };
  try {
    const r = await platformFetch<{ ok: boolean; notified?: number }>(
      `/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}/send`, c.userId, { method: "POST" },
    );
    refresh(clientId);
    const n = r.notified ?? 0;
    return { ok: true, id: contractId, notice: n > 0 ? `Sent. ${n} ${n === 1 ? "contact was" : "contacts were"} notified.` : "Sent. No portal contact has an address to notify, so tell the client yourself." };
  } catch (e) { return failSchedule(e, str(formData, "currency")); }
}

export async function voidContractAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  if (!clientId || !contractId) return { ok: false, error: "Missing contract." };
  try {
    await platformFetch(`/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}`, c.userId, {
      method: "PATCH", body: JSON.stringify({ status: "void" }),
    });
    refresh(clientId);
    return { ok: true, id: contractId, notice: "Voided." };
  } catch (e) { return fail(e); }
}

export async function countersignContractAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  const signerName = str(formData, "signerName");
  const signerTitle = str(formData, "signerTitle");
  if (!clientId || !contractId) return { ok: false, error: "Missing contract." };
  if (signerName.length < 2) return { ok: false, error: "Type your full name to sign.", field: "signerName" };
  try {
    const r = await platformFetch<{ ok: boolean; complete: boolean; alreadySigned: boolean }>(
      `/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}/countersign`, c.userId,
      { method: "POST", body: JSON.stringify({ signerName, ...(signerTitle ? { signerTitle } : {}) }) },
    );
    refresh(clientId);
    return {
      ok: true, id: contractId,
      notice: r.alreadySigned
        ? "Our signature was already on this contract."
        : r.complete ? "Countersigned. Both parties have signed, so the contract is now Signed." : "Countersigned. The contract becomes Signed once the client has signed too.",
    };
  } catch (e) { return fail(e, countersignErrorText); }
}

// PV5-09 (PV-D25): "Mark certified". Whether the button is enabled is the backend's `certifiedSigning.available` on the row
// (PV5-11, PV-D43: the simulated PSrE behind a server flag). While no provider is set up the API answers 409
// `no_certified_provider` and writes nothing, and that answer is put in words here rather than shown raw. The
// authority is the server either way: nothing here decides that a contract IS certified.
export async function markCertifiedAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  if (!clientId || !contractId) return { ok: false, error: "Missing contract." };
  try {
    await platformFetch(`/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}/mark-certified`, c.userId, {
      method: "POST", body: JSON.stringify({ certified: true }),
    });
    refresh(clientId);
    return { ok: true, id: contractId, notice: "Marked certified. It will be signed through a certified provider once it is sent." };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: markCertifiedErrorText(e.status, e.reason, e.message) };
    throw e;
  }
}

// PV5-11: our company's countersigner signs at the SIMULATED PSrE (review stage). Only a company owner may; the server answers
// 403 otherwise and that is put in words. Afterwards the contract is refreshed from the provider (best effort: a failure is
// ignored) so the billing tab shows it Signed when both parties have signed.
export async function countersignSimulatedPsreAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  const envelopeId = str(formData, "envelopeId");
  const signerName = str(formData, "signerName");
  const signerTitle = str(formData, "signerTitle");
  const documentSha256 = str(formData, "documentSha256");
  const agree = formData.get("agree") !== null;
  if (!clientId || !contractId || !envelopeId) return { ok: false, error: "Missing signing page." };
  if (signerName.length < 2) return { ok: false, error: "Type your full name to sign.", field: "signerName" };
  if (!agree) return { ok: false, error: "Confirm that you agree to the terms.", field: "agree" };
  try {
    await platformFetch(
      `/api/${c.tenant}/simulated-psre/envelopes/${encodeURIComponent(envelopeId)}/countersign`, c.userId,
      { method: "POST", body: JSON.stringify({ agree: true, signerName, ...(signerTitle ? { signerTitle } : {}), documentSha256 }) },
    );
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 409 && e.reason === "content_changed") revalidatePath(`/simulated-psre/${envelopeId}`);
      const message = e.status === 403 && !e.reason ? countersignErrorText(e.status, e.message) : simulatedSignErrorText(e.status, e.reason, e.message);
      return { ok: false, error: message, ...(e.field ? { field: e.field } : {}) };
    }
    throw e;
  }
  try {
    await platformFetch(`/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}/certified-signing/refresh`, c.userId, { method: "POST" });
  } catch {
    // Best effort: the signature is recorded either way.
  }
  refresh(clientId);
  revalidatePath(`/simulated-psre/${envelopeId}`);
  return { ok: true, id: contractId, notice: "Signed at the simulated PSrE." };
}

export async function decidePaymentAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const paymentId = str(formData, "paymentId");
  const decision = str(formData, "decision");
  const reason = str(formData, "reason");
  // The client hub names its client; the company-wide queue on Receivables (DW-7e-2) does not, so only the payment is required.
  if (!paymentId) return { ok: false, error: "Missing payment." };
  if (decision !== "confirm" && decision !== "reject") return { ok: false, error: "Choose confirm or reject." };
  const state = paymentDecisionState(decision, reason);
  if (!state.canSubmit) return { ok: false, error: state.reason ?? "A reason is required.", field: "reason" };
  try {
    const r = await platformFetch<{ ok: boolean; decision: string; invoicePaid?: boolean }>(
      `/api/${c.tenant}/invoice-payments/${encodeURIComponent(paymentId)}/decide`, c.userId,
      { method: "POST", body: JSON.stringify({ decision, ...(decision === "reject" ? { reason } : {}) }) },
    );
    if (clientId) refresh(clientId);
    // The invoice page shows the balance too, and the Finance queue and Overview count what is still pending.
    revalidatePath("/invoices");
    revalidatePath("/finance/receivables");
    revalidatePath("/finance");
    return {
      ok: true, id: paymentId,
      notice: decision === "reject" ? "Rejected. The client has been told why." : r.invoicePaid ? "Confirmed. The invoice is now settled." : "Confirmed. The balance is updated.",
    };
  } catch (e) { return fail(e, decideErrorText); }
}

// ── the payment schedule (DW-10f-2b, BFF §61.4 and §61.4a) ─────────────────────────────────────────────────────

/** The rows a form carries, as the editor posted them (`instalments`, JSON), or null when it is not a list of three strings. */
function rowsOf(fd: FormData): ScheduleDraftRow[] | null {
  let raw: unknown;
  try { raw = JSON.parse(String(fd.get("instalments") ?? "")); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const rows: ScheduleDraftRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const x = r as Record<string, unknown>;
    if (typeof x.label !== "string" || typeof x.amount !== "string" || typeof x.due !== "string") return null;
    rows.push({ label: x.label, amount: x.amount, due: x.due });
  }
  return rows;
}

/**
 * Save a DRAFT's payment schedule: `PUT contracts/:id/schedule` replaces the whole list in one transaction, and `[]` clears
 * it. It need not add up yet (the answer says `matchesValue`, and Send stays disabled until it does). The browser's checks
 * run first; the server repeats every one and is the authority. A sent contract answers 409 `schedule_frozen`.
 */
export async function saveScheduleAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  const currency = str(formData, "currency") || "IDR";
  if (!clientId || !contractId) return { ok: false, error: "Missing contract." };
  const rows = rowsOf(formData);
  if (!rows) return { ok: false, error: "The schedule could not be read. Reload the page and try again." };
  const bad = validateScheduleRows(rows, currency);
  if (bad) return { ok: false, error: bad.message, field: bad.field };
  try {
    const r = await platformFetch<Pick<ContractSchedule, "matchesValue" | "instalments">>(
      `/api/${c.tenant}/contracts/${encodeURIComponent(contractId)}/schedule`, c.userId,
      { method: "PUT", body: JSON.stringify(scheduleBody(rows)) },
    );
    refresh(clientId);
    return {
      ok: true, id: contractId,
      notice: rows.length === 0
        ? "Schedule cleared."
        : r.matchesValue ? "Schedule saved. It adds up to the value, so the contract can be sent." : "Schedule saved, but it does not add up to the value yet. The contract cannot be sent until it does.",
    };
  } catch (e) { return failSchedule(e, currency); }
}

/**
 * DW-D49: add a payment schedule to an agreement that is ALREADY signed, once (`POST contracts/:id/schedule/after-signing`).
 * A person's act: it is not a tool, and the route refuses an envelope call. The page offers the control to `company.manage`,
 * the gate the invoice screens use; the server authorizes `contract` `update` and `invoice` `create` and is the authority.
 * Every refusal of §61.4a is a sentence.
 */
export async function addScheduleAfterSigningAction(_prev: BillingActionState | null, formData: FormData): Promise<BillingActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "Select a company first." };
  if (!can(me, "company.manage", tenant) && !isElevated(me)) {
    return { ok: false, error: "Adding a payment schedule to a signed agreement is limited to finance administrators." };
  }
  const clientId = str(formData, "clientId");
  const contractId = str(formData, "contractId");
  const currency = str(formData, "currency") || "IDR";
  if (!clientId || !contractId) return { ok: false, error: "Missing contract." };
  const rows = rowsOf(formData);
  if (!rows) return { ok: false, error: "The schedule could not be read. Reload the page and try again." };
  const bad = validateScheduleRows(rows, currency, { requireOne: true });
  if (bad) return { ok: false, error: bad.message, field: bad.field };
  try {
    await platformFetch<ContractSchedule>(
      `/api/${tenant}/contracts/${encodeURIComponent(contractId)}/schedule/after-signing`, userId,
      { method: "POST", body: JSON.stringify(scheduleBody(rows)) },
    );
    refresh(clientId);
    revalidatePath("/invoices/new");
    return { ok: true, id: contractId, notice: "Payment schedule added. It is now fixed and its instalments can be invoiced." };
  } catch (e) { return failSchedule(e, currency); }
}
