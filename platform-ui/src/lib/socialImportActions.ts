"use server";
// SCP-6a (BFF §63.23): the sheet import's three server actions.
//
//   parseSheet     `POST import/parse`       a file (base64) or pasted text into tabs of text cells; writes nothing
//   previewImport  `POST import/allocation` or `import/plan`, `dryRun: true`    every row's outcome; writes nothing
//   applyImport    the same two routes, `dryRun: false`   one transaction: writes only when no row outside `skip` is refused
//
// All three are `social_engagement` · `plan`, the four Social approvers' alone; the gate in the page is a hint and the server's 403
// `not_a_social_approver` is the boundary. Every refusal comes back as the contract's own code in `error` (and its `field`), plus the words for
// it in `message`. A 409 `import_rows_refused` also carries the preview the server computed, in `detail`, so the page can draw the refused rows again.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { asImportAnswer, asParseAnswer, importRefusalText, type ImportAnswer, type ImportBody, type ImportKind, type SheetTab } from "./sheetImport";

export type ImportActionResult<T> = ({ ok: true } & T) | { ok: false; error: string; field?: string; message: string; detail?: ImportAnswer | null };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** The 409's `detail` (PlatformError keeps the raw body), parsed; null when it is missing or not a preview. */
function refusedPreview(e: PlatformError): ImportAnswer | null {
  const d = e.body && typeof e.body === "object" ? (e.body as { detail?: unknown }).detail : undefined;
  if (d === undefined) return null;
  try { return asImportAnswer(d); } catch { return null; }
}

async function run<T>(fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<ImportActionResult<T>> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "session_expired", message: importRefusalText("session_expired") };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "no_company", message: "No active company selected." };
  try {
    return { ok: true, ...(await fn({ userId, tenant })) };
  } catch (e) {
    if (e instanceof PlatformError) {
      const detail = e.status === 409 && e.message === "import_rows_refused" ? refusedPreview(e) : undefined;
      return { ok: false, error: e.message, field: e.field, message: importRefusalText(e.message, e.field), ...(detail !== undefined ? { detail } : {}) };
    }
    throw e;
  }
}

/** `POST import/parse`: `{filename, contentBase64}` (an .xlsx or .csv, 2 MiB at most) or `{text}` (pasted). Answers the tabs. */
export async function parseSheet(
  input: { filename: string; contentBase64: string } | { text: string },
): Promise<ImportActionResult<{ tabs: SheetTab[] }>> {
  return run(async (c) => {
    const raw = await platformFetch<unknown>(`${base(c.tenant)}/import/parse`, c.userId, { method: "POST", body: JSON.stringify(input) });
    return asParseAnswer(raw);
  });
}

async function send(kind: ImportKind, body: ImportBody, dryRun: boolean): Promise<ImportActionResult<{ answer: ImportAnswer }>> {
  return run(async (c) => {
    const raw = await platformFetch<unknown>(`${base(c.tenant)}/import/${kind}`, c.userId, { method: "POST", body: JSON.stringify({ ...body, dryRun }) });
    if (!dryRun) revalidatePath("/departments", "layout");
    return { answer: asImportAnswer(raw) };
  });
}

/** `dryRun: true`: writes nothing; answers every row's outcome, the names the server could not match and the counts. */
export async function previewImport(kind: ImportKind, body: ImportBody): Promise<ImportActionResult<{ answer: ImportAnswer }>> {
  return send(kind, body, true);
}

/** `dryRun: false`: runs the preview again inside one transaction and writes only when no row outside `skip` is refused (else 409 with `detail`). */
export async function applyImport(kind: ImportKind, body: ImportBody): Promise<ImportActionResult<{ answer: ImportAnswer }>> {
  return send(kind, body, false);
}
