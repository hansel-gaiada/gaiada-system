import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalHealth, getPortalOverview } from "@/lib/portal-data";
import { getPortalCentreResults } from "@/lib/clientCentre-data";
import { money, overallProgress, portalDate, relativeDays } from "@/lib/portal";
import { isClientOnly } from "@/lib/rbac";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalHealthBlock } from "@/components/portal/PortalHealthBlock";
import { PortalResultsHeadline } from "@/components/portal/PortalResultsHeadline";
import { PortalBar, PortalFacts, PortalFigure, PortalLink, PortalPageHead } from "@/components/portal/PortalBits";

// CP-8 — the portal's front page. Answers four questions, in this order:
//   1. What do you need from me?          (needsYou — first, always, even when empty)
//   2. How far along is my work?          (progress + next milestone)
//   3. What do I owe?                     (outstanding balance, and what is being verified)
//   4. What has been delivered?           (deliverable counts, linking out)
//
// "What needs you" leads because a client portal's single biggest failure is being a pretty read-only
// dashboard that never tells the client they are the blocker. Everything else on this page is context
// for that first block.
export default async function PortalOverviewPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;

  // No company resolved (PV2-05) means the caller is a client contact of NO company, so they are not a
  // portal client. They get the same explanation as the BFF's 403 below, never a bare "no workspace":
  // before PV2-05 a staff member reached the 403 through their own employer, and the teach-state was
  // what told them why the page is empty.
  //
  // PV7-03: the health read rides alongside the overview (one round trip of latency, not two). For anyone who is
  // not a portal client it is the BFF's 403, which the reader turns into `null` and this page ignores.
  const [{ overview, isPortalClient }, health] = tenant
    ? await Promise.all([getPortalOverview(userId, tenant), getPortalHealth(userId, tenant)])
    : [{ overview: null, isPortalClient: false }, null];

  // The BFF answers 403 for TWO different people and they need different words.
  //
  // It refuses anyone with no active `client_contacts` row — which is every staff member, and ALSO a
  // genuine client whose contact row has not been created yet or has been revoked. The first version of
  // this page collapsed both into "you're signed in as a staff member", so a real client — nine of whom
  // hold the `client` role on the live system with no contact row — was told they were staff. A false
  // statement, to a customer, on the first screen they see.
  //
  // `isClientOnly(me)` is the discriminator the UI already has: it means "holds the client role and no
  // staff role". Cerbos and the scope predicate remain the authority for ACCESS; this only decides which
  // explanation is true.
  if (!isPortalClient) {
    if (isClientOnly(me)) {
      return (
        <>
          <PortalPageHead
            eyebrow={me.name ?? "Your portal"}
            title="Your portal isn't linked yet"
            lead="Your account exists, but it hasn't been connected to your projects yet — so there's nothing to show you."
          />
          <EmptyNote>
            Nothing is wrong on your side, and there is nothing you need to do. Your account manager
            finishes the setup at their end; once they have, your projects, deliverables, invoices and
            contracts all appear here.
          </EmptyNote>
        </>
      );
    }
    return (
      <>
        <PortalPageHead
          eyebrow="Client portal"
          title="This is what your clients see"
          lead="You're signed in as a staff member, so there's no client account to resolve projects against. Track delivery internally under Delivery Pipeline."
        />
        <EmptyNote>
          A client signing in here sees their own projects, milestones, deliverables, invoices and
          contracts — and nothing else. Nothing on this surface is reachable without a client contact
          record.
        </EmptyNote>
      </>
    );
  }

  if (!overview) {
    return (
      <>
        <PortalPageHead eyebrow="Your workspace" title="Your portal" />
        <EmptyNote>
          Your portal is being set up. If this persists, reply to your account manager — nothing is
          wrong on your side.
        </EmptyNote>
      </>
    );
  }

  const now = new Date();
  // PV7-03: the results headline reads the portal's existing results route once per client the caller reaches. A
  // failed read is `null` (never an empty result), and the BFF itself says `visible: false` for a contact limited to
  // some projects (PV-D37), so nothing here decides who may see results.
  // The clients come from the health read when it succeeded (the same scope, one section each, so a results section lines
  // up with its health section), else from the overview's own list.
  const resultClients = health
    ? health.clients.map((c) => ({ id: c.clientId, name: c.name }))
    : overview.clients.length > 0 ? overview.clients : overview.client ? [overview.client] : [];
  const resultSections = await Promise.all(
    resultClients.map(async (c) => ({
      clientId: c.id,
      name: c.name,
      results: tenant ? await getPortalCentreResults(userId, tenant, c.id) : null,
    })),
  );
  const percent = overallProgress(overview);
  const fin = overview.finance.primary;
  const needs = overview.needsYou;

  return (
    <>
      <PortalPageHead
        eyebrow={overview.client?.name ?? "Your workspace"}
        title={needs.length > 0 ? "A few things need you" : "Everything's moving"}
        lead={
          needs.length > 0
            ? "Clear these and your projects keep moving. Everything else on this page is for information."
            : "Nothing is waiting on you right now. Here's where your work stands."
        }
      />

      <div className="cp-stack">
        {/* 1 — What needs you */}
        <Card
          title={needs.length > 0 ? "Waiting for you" : "Nothing needs you"}
          headerRight={<PortalLive />}
        >
          {needs.length === 0 ? (
            <div className="cp-callout cp-callout--calm">
              You&apos;re all caught up. We&apos;ll show anything that needs your signature or feedback
              right here — and email you as well, so you don&apos;t have to keep checking.
            </div>
          ) : (
            <div className="cp-needs">
              {needs.map((n) => (
                <div className="cp-need" key={`${n.kind}-${n.id}`}>
                  <div style={{ minWidth: 0 }}>
                    <div className="cp-need__label">{n.label}</div>
                    <div className="cp-need__context">
                      {n.context}
                      {n.since && ` · waiting since ${portalDate(n.since)}`}
                    </div>
                  </div>
                  <span className="cp-need__spacer" />
                  <Link href={n.href} className="btn btn-primary" style={{ fontSize: 13, textDecoration: "none" }}>
                    {/* The verb matches what the person will actually do, because "Open" on a
                        signature request understates what is being asked. */}
                    {n.requires === "signature" ? "Review & sign" : "Give feedback"}
                  </Link>
                </div>
              ))}
            </div>
          )}
          {overview.viewOnly && needs.some((n) => n.requires === "signature") && (
            <p style={{ margin: "12px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
              {/* Shown rather than hiding the item: a view-only stakeholder should know a signature is
                  outstanding — they are often the person who chases it. */}
              Your access is view-only, so a colleague with signing rights will need to complete the
              signature items. You can still read everything and send feedback.
            </p>
          )}
        </Card>

        {/* 1b — Project health (PV7-03): facts per client and project, never a verdict (L3). The blended progress card
            below is unchanged: it stays the all-clients figure; health is read per client here. */}
        <Card title="Project health">
          <PortalHealthBlock health={health} now={now} />
        </Card>

        {/* 2 — Progress */}
        <div className="cp-grid cp-grid--2">
          <Card title="Overall progress">
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <span style={{ font: "600 34px/1 var(--font-display)", color: "var(--ink-strong)" }}>{percent}%</span>
              <span style={{ font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
                across {overview.progress.activeProjects} active{" "}
                {overview.progress.activeProjects === 1 ? "project" : "projects"}
              </span>
            </div>
            <PortalBar percent={percent} />
            <div style={{ marginTop: 14 }}>
              <Eyebrow style={{ display: "block", marginBottom: 5 }}>Next milestone</Eyebrow>
              {overview.nextMilestone ? (
                <Link
                  href={`/portal/projects/${overview.nextMilestone.projectId}`}
                  style={{ font: "500 14px/1.4 var(--font-body)", color: "var(--ink-strong)", textDecoration: "none" }}
                >
                  {overview.nextMilestone.name}
                  <span style={{ color: "var(--ink-subtle)", fontWeight: 400 }}>
                    {" "}· {portalDate(overview.nextMilestone.dueDate)} ({relativeDays(overview.nextMilestone.dueDate, now)})
                  </span>
                </Link>
              ) : (
                <span style={{ font: "400 13px var(--font-body)", color: "var(--ink-subtle)" }}>
                  No dated milestones ahead.
                </span>
              )}
            </div>
            <div style={{ marginTop: 16 }}>
              <PortalLink href="/portal/projects">All projects</PortalLink>
            </div>
          </Card>

          {/* 3 — Money */}
          <Card title="Your account">
            {!fin ? (
              <EmptyNote>No invoices yet.</EmptyNote>
            ) : (
              <>
                <Eyebrow style={{ display: "block", marginBottom: 4 }}>Outstanding</Eyebrow>
                <div className={`cp-money${fin.overdueCount > 0 ? " cp-money--danger" : ""}`}>
                  {money(fin.outstanding, fin.currency)}
                </div>
                <div style={{ marginTop: 12 }}>
                  <PortalFacts
                    rows={[
                      { k: "Invoiced", v: money(fin.invoiced, fin.currency) },
                      { k: "Paid", v: money(fin.paid, fin.currency) },
                      // Only present when non-zero: a permanent "0 awaiting verification" row trains
                      // people to ignore the one time it matters.
                      ...(fin.pendingConfirmation > 0
                        ? [{
                            k: "Being verified",
                            v: (
                              <>
                                {money(fin.pendingConfirmation, fin.currency)}
                                <span style={{ color: "var(--ink-subtle)" }}> · we&apos;re checking this against our bank</span>
                              </>
                            ),
                          }]
                        : []),
                      ...(fin.overdueCount > 0
                        ? [{
                            k: "Overdue",
                            v: `${fin.overdueCount} ${fin.overdueCount === 1 ? "invoice" : "invoices"}`,
                            strong: true,
                          }]
                        : []),
                    ]}
                  />
                </div>
                {/* More than one currency is rare but real. Rather than silently showing only the
                    largest, say that there is more and let the invoices page show it properly. */}
                {overview.finance.byCurrency.length > 1 && (
                  <p style={{ margin: "10px 0 0", font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
                    Also billed in {overview.finance.byCurrency.slice(1).map((c) => c.currency).join(", ")}.
                  </p>
                )}
                <div style={{ marginTop: 16 }}>
                  <PortalLink href="/portal/invoices">Invoices &amp; payments</PortalLink>
                </div>
              </>
            )}
          </Card>
        </div>

        {/* 4 — Deliverables */}
        <Card title="Deliverables">
          <div className="cp-grid">
            <PortalFigure label="Delivered" value={`${overview.deliverables.delivered} of ${overview.deliverables.total}`} />
            <PortalFigure
              label="Overdue"
              value={String(overview.deliverables.overdue)}
              tone={overview.deliverables.overdue > 0 ? "danger" : undefined}
            />
            <PortalFigure label="Projects complete" value={`${overview.progress.completedProjects} of ${overview.progress.projects}`} />
          </div>
          <div style={{ marginTop: 16, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <PortalLink href="/portal/deliverables">Files &amp; deliverables</PortalLink>
            <PortalLink href="/portal/timeline">Full timeline</PortalLink>
          </div>
        </Card>

        {/* 5 — Results headline (PV7-03): the first figure of each running service, from the existing results route. */}
        <Card title="Results at a glance">
          <PortalResultsHeadline sections={resultSections} />
        </Card>
      </div>
    </>
  );
}
