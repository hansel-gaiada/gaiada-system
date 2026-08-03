"use client";
import { useActionState } from "react";
import Link from "next/link";
import { acceptInviteAction } from "@/lib/inviteActions";
import { MIN_PASSWORD_LENGTH, type AcceptResult } from "@/lib/invites";

// W0-5 — the client-facing half of the invite flow: choose a password, get an account.
//
// This is the ONE screen in the product shown to someone with no account and no session, so it holds
// itself to a different bar than an internal surface: no jargon, no internal identifiers, and every
// failure has to say what the person should DO next, because they cannot navigate anywhere else.
export function AcceptInviteForm({ token, clientName }: { token: string; clientName?: string | null }) {
  const [state, action, pending] = useActionState<AcceptResult | null, FormData>(acceptInviteAction, null);

  if (state?.ok) {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <p style={{ margin: 0, font: "600 15px var(--font-body)", color: "var(--ink)" }}>
          ✓ Your access is ready
        </p>
        <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--ink-muted)" }}>
          Sign in with <strong>{state.email}</strong> and the password you just chose.
        </p>
        <Link href="/login" className="btn btn-primary" style={{ justifySelf: "start", fontSize: 14, textDecoration: "none" }}>
          Sign in
        </Link>
      </div>
    );
  }

  // A spent token cannot be retried, so when the failure is terminal the form is REMOVED rather than
  // left on screen — re-submitting would only produce the same refusal and reads as a password problem.
  const terminal = state && !state.ok && !state.retryable;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <h1 style={{ margin: 0, font: "600 20px var(--font-display)", color: "var(--ink)" }}>
          Set up your client access
        </h1>
        <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--ink-muted)" }}>
          {clientName
            ? `You have been invited to follow ${clientName}'s project. `
            : "You have been invited to follow your project. "}
          Choose a password and you will be able to review and sign off on work as it is delivered.
        </p>
      </div>

      {terminal ? (
        <div style={{ display: "grid", gap: 12, padding: "14px 16px", border: "1px solid var(--line)", borderRadius: 10 }}>
          <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--erp-accent)" }}>{state!.error}</p>
          <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--ink-subtle)" }}>
            Invitation links are single use and expire, so this can simply mean it has already been used.
          </p>
        </div>
      ) : (
        <form action={action} style={{ display: "grid", gap: 12, maxWidth: 380 }}>
          {/* The token rides the form, not the request URL — see lib/inviteActions.ts. */}
          <input type="hidden" name="token" value={token} />
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ font: "500 13px var(--font-body)", color: "var(--ink)" }}>Choose a password</span>
            <input
              type="password"
              name="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              disabled={pending}
              style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 14px var(--font-body)" }}
            />
            <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
              At least {MIN_PASSWORD_LENGTH} characters.
            </span>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ font: "500 13px var(--font-body)", color: "var(--ink)" }}>Confirm password</span>
            <input
              type="password"
              name="confirm"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              disabled={pending}
              style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 14px var(--font-body)" }}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={pending} style={{ fontSize: 14, justifySelf: "start" }}>
            {pending ? "Setting up…" : "Create my access"}
          </button>
          {state && !state.ok && (
            <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--erp-accent)" }} aria-live="polite">
              {state.error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
