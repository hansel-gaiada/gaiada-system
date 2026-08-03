import { AcceptInviteForm } from "@/components/invite/AcceptInviteForm";

// W0-5 — the magic link's landing page. PUBLIC by design and deliberately a sibling of `(app)` rather
// than inside it: the person arriving has no account yet (creating one is the point), so the
// authenticated shell would have nothing to render and the middleware would bounce them to /login.
// `/invite` is on the middleware allowlist for that reason.
//
// This page does exactly two things: take the token out of its own URL, and hand it to a form that
// posts it in a request BODY. That is the whole reason the token is a path segment HERE and nowhere
// else — a bearer-equivalent secret in a URL is acceptable in the user's own browser and not in our
// server logs. See lib/inviteActions.ts.
//
// It deliberately does NOT pre-validate the token server-side before showing the form. Two reasons:
// the token is SINGLE USE, so a "check" would spend it and the real submission would then fail; and a
// pre-check that distinguishes valid from invalid would hand an unauthenticated caller the exact
// existence oracle the coarse refusal on the API side exists to deny.
export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  // Optional cosmetic hint the PM can include when sharing the link; it only ever affects the
  // greeting, never authorization or which invite is redeemed (that is the signed token's job alone).
  const rawClient = Array.isArray(sp.client) ? sp.client[0] : sp.client;
  const clientName = typeof rawClient === "string" ? rawClient.slice(0, 80) : null;

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-page)", padding: 24 }}>
      <div
        style={{
          width: "100%",
          maxWidth: 520,
          background: "var(--surface-card)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          padding: "28px 30px",
        }}
      >
        <AcceptInviteForm token={token} clientName={clientName} />
      </div>
    </main>
  );
}
