"use client";
import { useActionState } from "react";
import Link from "next/link";
import { acceptContributorInviteAction } from "@/lib/contributorInviteActions";
import { MIN_PASSWORD_LENGTH, type AcceptResult } from "@/lib/invites";

// M5-W1f: the freelance writer's half of the invite flow: choose a password, get an account. Modelled on `invite/AcceptInviteForm`.
// It is shown to someone with no account and no session, so: plain words, no internal identifiers, and every failure says what to do next.
// The token rides the form (a hidden field posted in the body), never the request URL.
export function AcceptContributorInviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptResult | null, FormData>(acceptContributorInviteAction, null);
  const muted = { margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--ink-muted)" } as const;

  if (state?.ok) {
    return (
      <div style={{ display: "grid", gap: 14 }} data-testid="contributor-accept-done">
        <p style={{ margin: 0, font: "600 15px var(--font-body)", color: "var(--ink)" }}>Your access is ready</p>
        {state.existingAccount ? (
          <p style={muted}>You already had an account, so its password was not changed. Sign in with it.</p>
        ) : (
          <p style={muted}>Sign in with <strong>{state.email}</strong> and the password you just chose.</p>
        )}
        <p style={muted}>
          The first time you sign in you will be asked to set up two-step sign-in with an authenticator app on your phone. The writers&apos; room
          only opens once that is done.
        </p>
        <Link href="/login" className="btn btn-primary" style={{ justifySelf: "start", fontSize: 14, textDecoration: "none" }}>Sign in</Link>
      </div>
    );
  }

  const terminal = state && !state.ok && !state.retryable;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <h1 style={{ margin: 0, font: "600 20px var(--font-display)", color: "var(--ink)" }}>Set up your writer access</h1>
        <p style={muted}>
          You have been invited to write for a website as a freelance contributor. Choose a password and you will be able to open the items
          assigned to you, edit them and send them for review.
        </p>
      </div>

      {terminal ? (
        <div style={{ display: "grid", gap: 12, padding: "14px 16px", border: "1px solid var(--line)", borderRadius: 10 }} data-testid="contributor-accept-terminal">
          <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--erp-accent)" }}>{state.error}</p>
          <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--ink-subtle)" }}>
            Invitation links are single use and expire after 72 hours, so this can simply mean it has already been used.
          </p>
        </div>
      ) : (
        <form action={action} style={{ display: "grid", gap: 12, maxWidth: 380 }}>
          <input type="hidden" name="token" value={token} />
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ font: "500 13px var(--font-body)", color: "var(--ink)" }}>Choose a password</span>
            <input type="password" name="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" disabled={pending}
              style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 14px var(--font-body)" }} />
            <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>At least {MIN_PASSWORD_LENGTH} characters.</span>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ font: "500 13px var(--font-body)", color: "var(--ink)" }}>Confirm password</span>
            <input type="password" name="confirm" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" disabled={pending}
              style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 14px var(--font-body)" }} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={pending} style={{ fontSize: 14, justifySelf: "start" }}>
            {pending ? "Setting up..." : "Create my access"}
          </button>
          {state && !state.ok && (
            <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--erp-accent)" }} aria-live="polite">{state.error}</p>
          )}
        </form>
      )}
    </div>
  );
}
