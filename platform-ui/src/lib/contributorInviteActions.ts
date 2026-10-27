"use server";

// M5-W1f: the freelance writer's invite acceptance (the sibling of `inviteActions.ts`, for the client portal).
//
// The person has no account yet, so this posts with NO auth header: the invite token is the only authority. It goes to the backend's public
// `POST /api/editorial-invites/accept` in the JSON BODY `{ token, password }`, from this server action (the browser posts the form to the page's
// own path, the token rides the form body, never a query string and never a path the BFF or the platform logs). A client invite token is refused by
// that route and a contributor token by the client one (own prefix, own key, own table), so a wrong link can never be redeemed on the wrong side.
//
// A "use server" module may export ONLY async functions, so the shared constant and result type live in ./invites (plain module).
import { MIN_PASSWORD_LENGTH, type AcceptResult } from "./invites";

export async function acceptContributorInviteAction(_prev: AcceptResult | null, formData: FormData): Promise<AcceptResult> {
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
    res = await fetch(`${base}/api/editorial-invites/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
      cache: "no-store",
    });
  } catch {
    // The token is still unspent after a transport failure, so this must not read like a rejected invitation.
    return { ok: false, error: "We could not reach the server. Please try again in a moment.", retryable: true };
  }

  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; email?: string; accountPath?: string; error?: string; reason?: string };

  if (res.ok && body.ok) return { ok: true, email: String(body.email ?? ""), existingAccount: body.accountPath === "existing_reenabled" };

  if (res.status === 503) {
    // The missing-configuration detail is for the operator; it never reaches an external writer's screen.
    return { ok: false, error: "Sign-in accounts are not fully set up yet. Please contact the person who invited you.", retryable: false };
  }
  // One coarse answer for an unknown, expired, spent, superseded or withdrawn link: it never says which (no existence oracle).
  if (body.reason === "contributor_invite_invalid") {
    return { ok: false, error: "This invitation link is no longer usable. Ask the person who invited you for a new one.", retryable: false };
  }
  if (res.status === 400) {
    return { ok: false, error: String(body.error ?? "Please check the details and try again."), retryable: true };
  }
  return { ok: false, error: "Something went wrong setting up your access. Please contact the person who invited you.", retryable: false };
}
