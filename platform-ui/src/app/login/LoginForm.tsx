"use client";
import { useActionState } from "react";
import { login } from "./actions";
import { Eyebrow } from "@/components/ui";

const SSO_ERRORS: Record<string, string> = {
  sso: "That sign-in attempt expired. Please try again.",
  token: "Couldn't complete sign-in with the identity provider.",
  provision: "Signed in, but no matching account exists on this platform.",
};

// Shown only once the identity panel itself is hidden at the narrow-viewport
// breakpoint (see login.css) — carries the brand mark so the form column is
// never brand-less on its own.
function BrandMark() {
  return (
    <div className="auth-form__brand">
      <span className="auth-form__wordmark">SYROWATKA</span>
      <Eyebrow className="auth-form__brand-eyebrow">Operating Platform</Eyebrow>
    </div>
  );
}

const FOOTER_NOTE = (
  <p className="auth-form__foot">
    Can&apos;t get in? That&apos;s almost always a position that hasn&apos;t been set up for you
    yet, not a password problem — ask whoever manages your team&apos;s roster to check it.
  </p>
);

export function LoginForm({
  returnTo,
  ssoOnly = false,
  ssoError,
}: {
  returnTo: string;
  ssoOnly?: boolean;
  ssoError?: string;
}) {
  const [state, action, pending] = useActionState(login, null);

  const ssoErrorBanner = ssoError && (
    <p className="auth-form__error" role="alert">
      {SSO_ERRORS[ssoError] ?? "Sign-in failed. Please try again."}
    </p>
  );

  // SSO-only: no email box at all. The dev-login server action is disabled in this mode, so
  // showing the field would invite the one interaction guaranteed to fail.
  if (ssoOnly) {
    return (
      <div className="auth-form">
        <BrandMark />
        <div className="auth-form__head">
          <h1 className="auth-form__title">Sign in</h1>
          <p className="auth-form__lede">Use your workspace identity to continue.</p>
        </div>
        {ssoErrorBanner}
        <a href={`/auth/login?return=${encodeURIComponent(returnTo)}`} className="auth-btn auth-btn--primary">
          Sign in with SSO
        </a>
        {FOOTER_NOTE}
      </div>
    );
  }

  return (
    <form action={action} className="auth-form">
      <BrandMark />
      <div className="auth-form__head">
        <h1 className="auth-form__title">Sign in</h1>
        <p className="auth-form__lede">
          Most staff use single sign-on. Use your work email only if SSO isn&apos;t set up for you yet.
        </p>
      </div>
      <input type="hidden" name="return" value={returnTo} />
      {ssoErrorBanner}
      <a href={`/auth/login?return=${encodeURIComponent(returnTo)}`} className="auth-btn auth-btn--primary">
        Sign in with SSO
      </a>
      <div className="auth-divider">
        <span />
        <Eyebrow className="auth-divider__label">or</Eyebrow>
        <span />
      </div>
      <label className="auth-field">
        <Eyebrow className="auth-field__label">Email</Eyebrow>
        {/* The accessible name comes from the wrapping <label>'s Eyebrow text
            ("Email") — several e2e specs resolve this input via getByLabel("Email"),
            so the placeholder is an example only and must never become the label. */}
        <input
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@gaiada.com"
          required
          className="auth-field__input"
        />
      </label>
      {state?.error && (
        <p className="auth-form__error" role="alert">
          {state.error}
        </p>
      )}
      {/* Secondary, deliberately: SSO above is the primary path most staff take.
          Two identical full-width accent buttons on one screen give the reader no
          steer about which door to use. */}
      <button type="submit" className="auth-btn auth-btn--secondary" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {FOOTER_NOTE}
    </form>
  );
}
