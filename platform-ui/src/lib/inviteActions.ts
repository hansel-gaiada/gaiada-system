"use server";

// W0-5 — the client-portal invite acceptance action.
//
// ── WHY THIS DOES NOT USE platformFetch ──────────────────────────────────────────────────────────
// `platformFetch(path, userId)` always attaches an identity: either the caller's OIDC access token or
// the service token plus `x-user-id`. There IS no caller here — the whole point of this flow is that
// the person accepting has no account yet, which is what the request creates. The platform's accept
// route is correspondingly the one route with no AuthGuard (see
// platform-nest/src/core/client-contacts.controller.ts's ClientInviteAcceptController, which is a
// SEPARATE controller class precisely so that exemption cannot leak onto its siblings).
//
// So this posts with no auth header at all. Its only authority is the invite token, which is why the
// token layer publishes an attack list (forgery, replay, wrong-address redemption, leaked-DB
// redemption, indefinite validity, cross-tenant read) rather than leaning on a session.
//
// ── AND WHY THE TOKEN IS IN THE BODY, NOT THE URL ────────────────────────────────────────────────
// It was a path parameter first, and that was a real bug: a token is ~146 chars and Fastify's router
// refuses to match a `:param` longer than `maxParamLength` (default 100), so every accept 404'd at the
// raw router before any application code ran. Beyond that, a bearer-equivalent secret in a URL lands
// in access logs, proxy logs, `Referer` headers and browser history. The token appears in a URL
// exactly once — the magic link in the user's own browser — and travels in a request body from there.

// A "use server" module may export ONLY async functions, so the shared constant and result type live
// in ./invites (a plain module). tsc and vitest both accept a const here; `next build`'s webpack pass
// does not — the failure surfaces late, so keep the split.
import { MIN_PASSWORD_LENGTH, type AcceptResult } from "./invites";

export async function acceptInviteAction(
  _prev: AcceptResult | null,
  formData: FormData,
): Promise<AcceptResult> {
  const token = String(formData.get("token") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!token) return { ok: false, error: "This link is missing its invitation code.", retryable: false };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Please choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`, retryable: true };
  }
  if (password !== confirm) return { ok: false, error: "The two passwords do not match.", retryable: true };

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let res: Response;
  try {
    res = await fetch(`${base}/api/invites/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
      cache: "no-store",
    });
  } catch {
    // A transport failure is retryable and must NOT read like a rejected invitation — the token is
    // still unspent in that case, so telling someone their link is invalid would be wrong.
    return { ok: false, error: "We could not reach the server. Please try again in a moment.", retryable: true };
  }

  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; email?: string; error?: string; code?: string };

  if (res.ok && body.ok) return { ok: true, email: String(body.email ?? "") };

  // The token is SINGLE-USE and is spent even by a failed attempt, so `retryable` here means "the
  // password form is worth showing again", not "this link still works". Only a 400 from the password
  // rule leaves the form usable; an invalid/expired token and a provisioning failure both do not.
  if (res.status === 503) {
    return {
      ok: false,
      // Deliberately does not surface the missing env-var list to an external client — that detail is
      // for the operator and reaches them via the API response and logs, not via the client's screen.
      error: "Client access is not fully configured yet. Please contact your project manager.",
      retryable: false,
    };
  }
  if (body.code === "client_invite_invalid") {
    return { ok: false, error: "This invitation link is no longer usable. Ask your project manager for a new one.", retryable: false };
  }
  if (res.status === 400) {
    return { ok: false, error: String(body.error ?? "Please check the details and try again."), retryable: true };
  }
  return { ok: false, error: "Something went wrong setting up your access. Please contact your project manager.", retryable: false };
}
