"use server";
// DW-8j UI: the writes behind /me/mail (BFF §48). The platform is the authority (Cerbos: the person's own mailbox; the client's read for a
// context). Every action RETURNS a value, never a thrown refusal. The tenant is the caller's ACTIVE company, never a value from the browser.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { disconnectPath, gmailErrorText, sendPath, splitAddresses, startPath, validateCompose } from "./gmail";

export type GmailResult<T> = ({ ok: true } & T) | { ok: false; error: string; field?: string };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

function fail(e: unknown): { ok: false; error: string; field?: string } {
  if (e instanceof PlatformError) {
    const retry = (e.body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    return {
      ok: false,
      error: gmailErrorText({ status: e.status, error: e.message, reason: e.reason, field: e.field, retryAfterSeconds: typeof retry === "number" ? retry : null }),
      field: e.field,
    };
  }
  throw e;
}

const BROKEN = { ok: false as const, error: "The platform answered in a way we couldn't read. Reload the page to see where things stand." };

/** Google's consent screen is Google's: an https URL, nothing else, is ever navigated to. */
const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** Simulated: links at once (`linked`). Live: returns Google's consent URL for the caller to navigate to. */
export async function connectGmailAction(): Promise<GmailResult<{ linked?: true; authUrl?: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const raw = await platformFetch<{ linked?: unknown; authUrl?: unknown }>(startPath(c.tenant), c.userId);
    if (raw?.linked === true) return { ok: true, linked: true };
    if (isHttpsUrl(raw?.authUrl)) return { ok: true, authUrl: raw.authUrl };
    return BROKEN;
  } catch (e) {
    return fail(e);
  }
}

export async function disconnectGmailAction(): Promise<GmailResult<object>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch<unknown>(disconnectPath(c.tenant), c.userId, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export interface SendInput {
  to: string;
  cc: string;
  subject: string;
  body: string;
  inReplyTo?: { threadId: string; messageId: string };
  clientId?: string;
}

/** Sends as the caller. Validated here with the same rules as the platform (which stays the authority). */
export async function sendGmailAction(input: SendInput): Promise<GmailResult<{ messageId: string; threadId: string }>> {
  const errs = validateCompose(input);
  const first = (Object.keys(errs) as Array<keyof typeof errs>)[0];
  if (first) return { ok: false, error: errs[first] as string, field: first };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const cc = splitAddresses(input.cc);
  try {
    const raw = await platformFetch<{ messageId?: unknown; threadId?: unknown }>(sendPath(c.tenant), c.userId, {
      method: "POST",
      body: JSON.stringify({
        to: splitAddresses(input.to),
        ...(cc.length ? { cc } : {}),
        subject: input.subject.trim(),
        body: input.body,
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        ...(input.clientId ? { context: { kind: "client", id: input.clientId } } : {}),
      }),
    });
    if (typeof raw?.messageId !== "string" || typeof raw?.threadId !== "string") return BROKEN;
    return { ok: true, messageId: raw.messageId, threadId: raw.threadId };
  } catch (e) {
    return fail(e);
  }
}
