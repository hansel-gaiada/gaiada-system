import Link from "next/link";
import { Eyebrow } from "@/components/ui";
import { sanitizeReturnToParam } from "@/lib/returnTo";
import "../login/login.css";

// D4 identity step-up landing. WA/Telegram (low-assurance) users are routed
// here when they attempt a sensitive action. Public route (see middleware).
// Reads ?return= to send the user back after a full sign-in.
//
// Shares login.css's `.auth-*` classes with /login (same file, imported by
// path since this route has no companion identity panel of its own) so
// re-auth reads as the same product, not a second screen.
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function StepUpPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const returnTo = sanitizeReturnToParam(sp.return);
  const signInHref = `/login?return=${encodeURIComponent(returnTo)}`;

  return (
    <main className="auth-single">
      <div className="auth-card">
        <div className="auth-card__brand">
          <span className="auth-form__wordmark">SYROWATKA</span>
          <Eyebrow className="auth-card__eyebrow">Identity verification</Eyebrow>
        </div>

        <h1 className="auth-card__title">A stronger sign-in is needed</h1>

        <p className="auth-card__body">
          The action you requested touches company data or changes records. Chat sessions
          (WhatsApp / Telegram) are low-assurance, so we need you to complete a full sign-in
          before continuing. Once verified, you&apos;ll be returned to where you left off.
        </p>

        <div className="auth-card__return">
          <Eyebrow className="auth-card__return-label">Returning to</Eyebrow>
          <div className="auth-card__return-value">{returnTo}</div>
        </div>

        <Link href={signInHref} className="auth-btn auth-btn--primary">
          Continue to sign in
        </Link>

        <p className="auth-card__foot">
          This dual-proof step (D4) is how the platform links your chat identity to a verified
          principal without ever letting the bot assert who you are.
        </p>
      </div>
    </main>
  );
}
