import Link from "next/link";
import { Eyebrow } from "@/components/ui";
import { sanitizeReturnToParam } from "@/lib/returnTo";

// D4 identity step-up landing. WA/Telegram (low-assurance) users are routed
// here when they attempt a sensitive action. Public route (see middleware).
// Reads ?return= to send the user back after a full sign-in.
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function StepUpPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const returnTo = sanitizeReturnToParam(sp.return);
  const signInHref = `/login?return=${encodeURIComponent(returnTo)}`;

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-page)" }}>
      <div
        style={{
          width: 460,
          maxWidth: "calc(100vw - 40px)",
          background: "var(--surface-card)",
          border: "0.5px solid var(--erp-hairline)",
          padding: 40,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 26, letterSpacing: "0.14em" }}>SYROWATKA</div>
          <Eyebrow style={{ color: "var(--erp-accent)", marginTop: 9, display: "block" }}>Identity verification</Eyebrow>
        </div>

        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 24, lineHeight: 1.2 }}>
          A stronger sign-in is needed
        </h1>

        <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--ink-muted)" }}>
          The action you requested touches company data or changes records. Chat sessions
          (WhatsApp / Telegram) are low-assurance, so we need you to complete a full sign-in
          before continuing. Once verified, you&apos;ll be returned to where you left off.
        </p>

        <div style={{ border: "0.5px solid var(--erp-hairline-soft)", padding: "12px 14px", background: "var(--tint-hover)" }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Returning to</Eyebrow>
          <div style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)", marginTop: 4, wordBreak: "break-all" }}>{returnTo}</div>
        </div>

        <Link href={signInHref} className="lux-btn lux-btn--solid lux-btn--md" style={{ justifyContent: "center" }}>
          Continue to sign in
        </Link>

        <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
          This dual-proof step (D4) is how the platform links your chat identity to a verified
          principal without ever letting the bot assert who you are.
        </p>
      </div>
    </main>
  );
}
