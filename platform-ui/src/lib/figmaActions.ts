"use server";
// DW-6k UI: the writes behind the Designs section and the Figma block of Tools & connections (BFF §36.5, §36.8).
//
// The platform is the authority on every one of these (Cerbos on the target's own kind; `integration_connection` · `manage`
// for the connection). Nothing here widens or pre-empts that. Every action RETURNS a value, never a thrown refusal, so the UI
// says what happened in words: a 403 is a calm sentence. The tenant is the caller's ACTIVE company, never a value from the
// browser. The Figma token crosses this file once, inbound, and is never logged, returned or echoed.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  EXPORT_FORMATS, FIGMA_TARGET_KINDS, connectionPath, createLinkPath, exportPath, figmaErrorText, linkPath,
  normalizeConnection, normalizeExport, normalizeLink,
  type ExportFormat, type FigmaConnection, type FigmaExport, type FigmaLink, type FigmaTargetKind, type FigmaTokenType,
} from "./figma";

export type FigmaResult<T> = ({ ok: true } & T) | { ok: false; error: string };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof PlatformError) return { ok: false, error: figmaErrorText({ status: e.status, error: e.message, reason: e.reason }) };
  throw e;
}

const BROKEN = { ok: false as const, error: "The platform answered in a way we couldn't read. Reload the page to see where things stand." };

/** `POST figma-links` `{ targetKind, targetId, url }`. The write check on the target is the server's. */
export async function addFigmaLinkAction(targetKind: FigmaTargetKind, targetId: string, url: string): Promise<FigmaResult<{ link: FigmaLink }>> {
  if (!(FIGMA_TARGET_KINDS as readonly string[]).includes(targetKind) || !targetId) return { ok: false, error: figmaErrorText({ error: "bad_target" }) };
  const pasted = (url ?? "").trim();
  if (!pasted) return { ok: false, error: "Paste a Figma link first." };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const raw = await platformFetch<unknown>(createLinkPath(c.tenant), c.userId, {
      method: "POST",
      body: JSON.stringify({ targetKind, targetId, url: pasted }),
    });
    const link = normalizeLink(raw);
    return link ? { ok: true, link } : BROKEN;
  } catch (e) {
    return fail(e);
  }
}

/** `DELETE figma-links/:id`. A soft delete: exported assets stay in the Asset Library. */
export async function removeFigmaLinkAction(linkId: string): Promise<FigmaResult<object>> {
  if (!linkId) return { ok: false, error: figmaErrorText({ error: "link_not_found" }) };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch<unknown>(linkPath(c.tenant, linkId), c.userId, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** `POST figma-links/:id/export` `{ format, scale? }`. Lands in the Asset Library as the link's next version. */
export async function exportFigmaLinkAction(linkId: string, format: ExportFormat, scale?: 1 | 2 | 3): Promise<FigmaResult<{ export: FigmaExport }>> {
  if (!linkId) return { ok: false, error: figmaErrorText({ error: "link_not_found" }) };
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) return { ok: false, error: figmaErrorText({ error: "bad_export" }) };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const raw = await platformFetch<unknown>(exportPath(c.tenant, linkId), c.userId, {
      method: "POST",
      body: JSON.stringify(scale ? { format, scale } : { format }),
    });
    const out = normalizeExport(raw);
    return out ? { ok: true, export: out } : BROKEN;
  } catch (e) {
    return fail(e);
  }
}

/** `PUT integrations/figma` `{ token, tokenType }`. `company.manage`. The answer is the masked status, never the token. */
export async function connectFigmaAction(token: string, tokenType: FigmaTokenType): Promise<FigmaResult<{ connection: FigmaConnection }>> {
  if (tokenType !== "pat" && tokenType !== "oauth") return { ok: false, error: figmaErrorText({ error: "bad_token_type" }) };
  const t = (token ?? "").trim();
  if (!t) return { ok: false, error: "Paste the Figma token first." };
  if (/\s/.test(t)) return { ok: false, error: figmaErrorText({ error: "bad_token" }) };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const raw = await platformFetch<unknown>(connectionPath(c.tenant), c.userId, {
      method: "PUT",
      body: JSON.stringify({ token: t, tokenType }),
    });
    const connection = normalizeConnection(raw);
    return connection ? { ok: true, connection } : BROKEN;
  } catch (e) {
    return fail(e);
  }
}

/** `DELETE integrations/figma`. `company.manage`. Links keep their cached values. */
export async function disconnectFigmaAction(): Promise<FigmaResult<object>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch<unknown>(connectionPath(c.tenant), c.userId, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
