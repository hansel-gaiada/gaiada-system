import { AcceptContributorInviteForm } from "@/components/contributor/AcceptContributorInviteForm";

// M5-W1f: the freelance writer's invite page, `/contributor-invite/<token>`. PUBLIC (see `proxy.ts`), a sibling of `(app)` and of `/invite`, for the
// same reason as `/invite`: the person has no account yet. The path is the backend's own `acceptPath`, and it cannot collide with the client
// invite (`/invite/<token>`): different first segment, and the backend refuses a client token here and a contributor token on the client route.
//
// This page only takes the token out of its own URL and hands it to a form that posts it in a request BODY (see lib/contributorInviteActions.ts).
// It deliberately does NOT pre-validate the token: the token is single use, and a check that tells valid from invalid would be an existence oracle.
export const dynamic = "force-dynamic";

export default async function ContributorInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-page)", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 520, background: "var(--surface-card)", border: "1px solid var(--line)", borderRadius: 14, padding: "28px 30px" }}>
        <AcceptContributorInviteForm token={token} />
      </div>
    </main>
  );
}
