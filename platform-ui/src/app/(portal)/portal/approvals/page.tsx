import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { listPortalRuns } from "@/lib/portal-data";
import { getPortalSpend } from "@/lib/socialBoosts-data";
import { portalSpendHasContent } from "@/lib/socialBoosts";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";
import { PortalBoostBudgets } from "@/components/portal/social/PortalBoostBudgets";
import "@/components/pipeline/pipeline.css";

// CP-12 — the deliveries needing the client's sign-off. This is the WS11 `/portal` list, MOVED here.
//
// Why it moved: `/portal` is now the dashboard, and the old page's own route (`/portal/[runId]` for the
// detail) was a dynamic segment sitting directly under `/portal` — one static sibling away from
// swallowing `/portal/invoices`. Static routes win in Next, so it worked, but it is a trap that fires
// the first time someone adds a route without noticing. `/portal/approvals/[runId]` has no such
// ambiguity.
//
// The summary shape is unchanged: `/portal/runs` returns the blockage line and a pending-action count in
// two queries total, so this page issues ONE request regardless of how many projects the client has.
//
// SCP-4b (BFF §63.11): the page also carries the "Boost budgets" section, from `GET portal/social/spend` (a second, independent read): the month budgets the team proposed and the boosts over
// the month's agreed budget that wait for the client, each with Agree or Approve and Decline for a contact with signing capability. The section is ABSENT when there is nothing waiting and no
// history, and for a caller the portal refuses (a staff member, 403); a read that fails says so in one line rather than leaving the section out, because an approval that waits for the client
// must never read as "nothing to approve".
export default async function PortalApprovalsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const { runs, isPortalClient } = await listPortalRuns(userId, tenant);
  // Runs needing the client first: a list whose top card is settled work buries the one thing that is
  // actually waiting on them.
  const ordered = [...runs].sort((a, b) => (b.pendingActions ?? 0) - (a.pendingActions ?? 0));
  const waiting = ordered.reduce((n, r) => n + (r.pendingActions ?? 0), 0);
  const spend = isPortalClient ? await getPortalSpend(userId, tenant) : null;

  return (
    <>
      <PortalPageHead
        eyebrow="Your input"
        title="Approvals & sign-offs"
        lead={
          waiting > 0
            ? "These need a signature or your feedback before we can continue."
            : "Nothing needs your sign-off right now. Past decisions stay here for your records."
        }
        actions={<PortalLive topics={["approvals"]} />}
      />

      {runs.length === 0 ? (
        isPortalClient ? (
          <EmptyNote>No deliveries yet. Once your kickoff is processed, it appears here.</EmptyNote>
        ) : (
          <EmptyNote>
            This is the client-facing portal. You&apos;re signed in as a staff member, so there is no
            client account to resolve deliveries against. Track delivery internally under Delivery
            Pipeline.
          </EmptyNote>
        )
      ) : (
        <div className="cp-stack">
          {ordered.map((r) => (
            <Card key={r.id} title={r.title ?? "Delivery"} headerRight={<PortalStatus status={r.status} />}>
              <div className={(r.pendingActions ?? 0) > 0 ? "cp-callout" : "cp-callout cp-callout--calm"}>
                {r.currentBlockage}
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", marginTop: 12 }}>
                {/* Stated as a count, not a generic "action needed": a client with two signatures
                    outstanding should not open the delivery expecting one. */}
                {(r.pendingActions ?? 0) > 0 ? (
                  <span style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
                    {r.pendingActions === 1 ? "1 thing needs you" : `${r.pendingActions} things need you`}
                  </span>
                ) : (
                  <span style={{ font: "400 13px var(--font-body)", color: "var(--ink-subtle)" }}>
                    Nothing needed from you right now
                  </span>
                )}
                <Link
                  href={`/portal/approvals/${r.id}`}
                  className={(r.pendingActions ?? 0) > 0 ? "btn btn-primary" : "btn"}
                  style={{ fontSize: 13, textDecoration: "none" }}
                >
                  {(r.pendingActions ?? 0) > 0 ? "Review & sign" : "Open"}
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      {spend?.kind === "ok" && portalSpendHasContent(spend.data) && <PortalBoostBudgets spend={spend.data} tenant={tenant} />}
      {spend?.kind === "unavailable" && <EmptyNote>The boost budgets could not be loaded just now. Reload the page to try again.</EmptyNote>}
    </>
  );
}
