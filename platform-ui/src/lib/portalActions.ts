"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { getActiveTenant } from "./tenant";

// Client-portal WRITE actions: the client signs their gates and contracts, records a payment against
// their own invoice, updates their own profile, and asks for a change to their company record.
//
// The portal BFF enforces client-role + per-client/per-project ownership + signing capability, so
// there is no staff capability gate here. What this file DOES owe the caller is an honest result.
//
// ── TWO RESULT SHAPES, ON PURPOSE ─────────────────────────────────────────────────────────────────
// The two WS11 actions (`portalDecideGate`, `portalScopeSign`) return `void` because they are wired
// directly as `<form action={...}>` handlers, where React requires a void return. They swallow
// PlatformError and revalidate — acceptable for a gate decision, where the refreshed page shows the
// new state.
//
// Everything added since returns `{ ok, error?, field? }` (the repo's documented actions shape) and is
// driven from a client component via `useActionState`. That is not stylistic: a client typing their
// name to SIGN A CONTRACT, or recording a bank transfer, must be TOLD when the server refused — and
// the server does refuse, for reasons the client can act on ("your access is view-only", "amount
// exceeds the outstanding balance", "this agreement is expired"). A void action turns every one of
// those into a page that silently re-renders unchanged, which reads as "the button is broken".
export interface PortalActionResult {
  ok: boolean;
  error?: string;
  field?: string;
  id?: string;
}

async function ctx(): Promise<{ userId: string; tenant: string } | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const me: Me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return null;
  return { userId, tenant };
}

/** Map a thrown PlatformError to a result. The backend's own message is surfaced verbatim: these are
 *  written for a client to read (see the BFF's BadRequestException strings), so replacing them with a
 *  generic "something went wrong" would discard the only actionable part. */
function fail(e: unknown): PortalActionResult {
  if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field };
  throw e;
}

/** Revalidate every portal surface a write can affect.
 *
 *  Deliberately broad. The portal's pages cross-reference each other — a signed contract changes the
 *  overview's "needs you" list, the contract page AND the timeline; a payment changes the invoice, the
 *  invoice list and the overview's outstanding balance. Revalidating only the page the user is on left
 *  a stale "1 thing needs you" badge on the dashboard behind them, which is exactly the kind of wrong
 *  number that erodes trust in the whole surface. `revalidatePath` on a handful of static routes is
 *  cheap; a client-visible inconsistency is not.
 *
 *  `/portal/*` layout paths are NOT used here because `revalidatePath` with a dynamic segment needs the
 *  concrete path — so dynamic detail pages take their own explicit call from the caller. */
function revalidatePortal(): void {
  for (const p of ["/portal", "/portal/projects", "/portal/timeline", "/portal/deliverables",
    "/portal/approvals", "/portal/invoices", "/portal/contracts", "/portal/profile", "/portal/requests"]) {
    revalidatePath(p);
  }
}

// ── WS11: gate decisions + scope sign-off (form-action shape, void) ───────────────────────────────

/** Client decides one of THEIR client-side gates (sign the PRD, or approve/request-changes feedback). */
export async function portalDecideGate(formData: FormData): Promise<void> {
  const c = await ctx();
  if (!c) return;
  const gateId = String(formData.get("gateId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "");
  if (!gateId || !decision) return;
  try {
    await platformFetch(`/api/${c.tenant}/portal/gates/${gateId}/decide`, c.userId, {
      method: "POST",
      body: JSON.stringify({ decision, note: note || undefined }),
    });
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
  }
  revalidatePortal();
}

/** Client signs the Scope Agreement (the `client` party) for one of their runs. */
export async function portalScopeSign(formData: FormData): Promise<void> {
  const c = await ctx();
  if (!c) return;
  const runId = String(formData.get("runId") ?? "");
  const gateId = String(formData.get("gateId") ?? "");
  const signerName = String(formData.get("signerName") ?? "");
  if (!runId) return;
  try {
    await platformFetch(`/api/${c.tenant}/portal/runs/${runId}/scope-sign`, c.userId, {
      method: "POST",
      body: JSON.stringify({ gateId: gateId || undefined, signerName: signerName || undefined }),
    });
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
  }
  revalidatePortal();
}

// ── CP-3/CP-4: contracts, payments, profile (result shape, driven by useActionState) ──────────────

/** Countersign a contract. `_prev` is useActionState's previous-state argument. */
export async function portalSignContract(_prev: PortalActionResult | null, formData: FormData): Promise<PortalActionResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Your session has expired — please sign in again." };
  const contractId = String(formData.get("contractId") ?? "");
  const signerName = String(formData.get("signerName") ?? "").trim();
  const signerTitle = String(formData.get("signerTitle") ?? "").trim();
  // `agree` is a checkbox: absent from FormData entirely when unticked, so this must test presence
  // rather than a truthy value. The server refuses without it too — this is the fast path, not the gate.
  const agree = formData.get("agree") !== null;
  if (!contractId) return { ok: false, error: "Missing contract." };
  if (signerName.length < 2) return { ok: false, error: "Please type your full name.", field: "signerName" };
  if (!agree) return { ok: false, error: "Please confirm you agree to the terms.", field: "agree" };
  try {
    // The response's `complete`/`alreadySigned` are deliberately NOT surfaced as a message: the
    // re-rendered page shows the signature and the resulting status, which says it better than a
    // toast would. Both are success.
    await platformFetch<{ complete: boolean; alreadySigned: boolean }>(
      `/api/${c.tenant}/portal/contracts/${contractId}/sign`, c.userId,
      { method: "POST", body: JSON.stringify({ signerName, signerTitle: signerTitle || undefined, agree: true }) },
    );
    revalidatePortal();
    revalidatePath(`/portal/contracts/${contractId}`);
    return { ok: true, id: contractId };
  } catch (e) {
    return fail(e);
  }
}

/** Record a payment against one of the caller's invoices, with an optional proof receipt.
 *
 *  The receipt is read here (server side) and forwarded as base64 in the JSON body, matching the BFF's
 *  contract. It is NOT sent via `platformUpload`/multipart: the payment and its proof must be ONE
 *  transaction, and a two-step upload-then-link leaves an orphan file whenever the second call fails —
 *  the exact failure mode the single-request design in the BFF was chosen to avoid. */
export async function portalRecordPayment(_prev: PortalActionResult | null, formData: FormData): Promise<PortalActionResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Your session has expired — please sign in again." };
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = Number(formData.get("amount"));
  const paidOn = String(formData.get("paidOn") ?? "");
  const method = String(formData.get("method") ?? "bank_transfer");
  const reference = String(formData.get("reference") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!invoiceId) return { ok: false, error: "Missing invoice." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter the amount you paid.", field: "amount" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return { ok: false, error: "Enter the date you paid.", field: "paidOn" };

  let proof: { filename: string; contentType: string; content: string } | undefined;
  const file = formData.get("proof");
  // `instanceof File` rather than a truthiness check: an empty file input yields a File of size 0, and
  // sending that as a base64 body makes the BFF reject the whole payment for "empty proof" — losing a
  // payment record because the customer chose not to attach a receipt.
  if (file instanceof File && file.size > 0) {
    if (file.size > 10 * 1024 * 1024) return { ok: false, error: "That receipt is larger than 10 MB.", field: "proof" };
    const buf = Buffer.from(await file.arrayBuffer());
    proof = {
      filename: file.name || "receipt",
      contentType: file.type || "application/octet-stream",
      content: buf.toString("base64"),
    };
  }

  try {
    const r = await platformFetch<{ id: string }>(
      `/api/${c.tenant}/portal/invoices/${invoiceId}/payments`, c.userId,
      {
        method: "POST",
        body: JSON.stringify({ amount, paidOn, method, reference: reference || undefined, note: note || undefined, proof }),
      },
    );
    revalidatePortal();
    revalidatePath(`/portal/invoices/${invoiceId}`);
    return { ok: true, id: r.id };
  } catch (e) {
    return fail(e);
  }
}

/** Update the caller's own name/title. */
export async function portalUpdateProfile(_prev: PortalActionResult | null, formData: FormData): Promise<PortalActionResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Your session has expired — please sign in again." };
  const name = String(formData.get("name") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (name.length < 2) return { ok: false, error: "Please enter your name.", field: "name" };
  try {
    await platformFetch(`/api/${c.tenant}/portal/profile`, c.userId, {
      method: "PATCH",
      body: JSON.stringify({ name, title }),
    });
    revalidatePortal();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Ask the agency to change the client's own record. Recorded + notified; nothing is mutated. */
export async function portalRequestProfileChange(_prev: PortalActionResult | null, formData: FormData): Promise<PortalActionResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Your session has expired — please sign in again." };
  const message = String(formData.get("message") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "");
  if (message.length < 5) return { ok: false, error: "Tell us what to change.", field: "message" };
  try {
    await platformFetch(`/api/${c.tenant}/portal/profile/change-request`, c.userId, {
      method: "POST",
      body: JSON.stringify({ message, clientId: clientId || undefined }),
    });
    revalidatePath("/portal/profile");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── MI-04: maintenance intake (webdev change requests) ─────────────────────────────────────────────

const CHANGE_REQUEST_KINDS = new Set(["content", "design", "feature", "bug"]);

/** Submit a webdev change request. Mirrors `webdev-change-requests-portal.controller.ts`'s `create`
 *  exactly: `kind`/`title`/`body`/`projectId` are the only fields sent, and NEVER `clientId`/`status` —
 *  the backend derives those from the caller's own scope and ignores anything the body supplies for
 *  them (the design doc's "rule 1"). `projectId` is sent as `undefined` (omitted) rather than `""` for
 *  a client-wide submission — the backend's own check is `typeof bodyProjectId === "string" &&
 *  bodyProjectId`, so an empty string would be treated identically, but omitting it says what actually
 *  happened (no project named) rather than relying on that coincidence.
 *
 *  ⚠ NO signing-capability check here, and none belongs here — §5.1 of the design doc (test-pinned on
 *  the backend) is that submitting is a viewer-permitted act. Adding a `requireSigner`-style gate to
 *  this action would silently narrow a ratified decision back to signers-only. */
export async function portalSubmitChangeRequest(_prev: PortalActionResult | null, formData: FormData): Promise<PortalActionResult> {
  const c = await ctx();
  if (!c) return { ok: false, error: "Your session has expired — please sign in again." };
  const kind = String(formData.get("kind") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!CHANGE_REQUEST_KINDS.has(kind)) {
    return { ok: false, error: "Choose what kind of request this is.", field: "kind" };
  }
  if (title.length < 3) return { ok: false, error: "Tell us what you need in a few words.", field: "title" };
  try {
    const r = await platformFetch<{ id: string; status: string }>(
      `/api/${c.tenant}/portal/change-requests`, c.userId,
      {
        method: "POST",
        body: JSON.stringify({ kind, title, body: body || undefined, projectId: projectId || undefined }),
      },
    );
    revalidatePortal();
    return { ok: true, id: r.id };
  } catch (e) {
    return fail(e);
  }
}
