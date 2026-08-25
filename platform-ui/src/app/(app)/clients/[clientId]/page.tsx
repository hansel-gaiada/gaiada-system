import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getClientOverview } from "@/lib/clientHub";
import { Card, KpiTile, StatusBadge } from "@/components/ui";
import { ClientBallList } from "@/components/clients/ClientBallList";
import { formatDate } from "@/lib/format";

// CC-3 — the client hub Overview: who is holding the ball, and what shape the relationship is in.
//
// The two ball lists come FIRST, above the tiles, on purpose. Counts describe the relationship;
// the ball lists are the only part of this page anybody can act on, and a dashboard that leads with
// figures teaches the reader to scroll past the actionable half.
//
// The aggregate is fetched by the LAYOUT too — Next dedupes the identical fetch inside one render
// pass, so this is not a second round trip. Do not "optimize" it into a prop drill; a layout passing
// data to `children` is not something Next supports without turning the tab into a client component.

/** Staleness threshold for OUR side of the ball. 7 days is not arbitrary: a client-recorded payment
 *  awaiting confirmation is the item most likely to sit here, and finance runs on a weekly cycle, so
 *  anything past one cycle has been missed rather than merely queued. */
const STALE_AFTER_DAYS = 7;

export default async function ClientOverviewPage({ params }: { params: Promise<{ clientId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const o = await getClientOverview(userId, tenant, clientId);
  if (!o) notFound();

  // Resolved ONCE, here, and passed down — never read from the clock inside the list component,
  // which would render one value on the server and another in the browser.
  const today = new Date();
  const money = o.money.primary;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="ch-ball">
        <Card
          title="Waiting on us"
          headerRight={o.needsUs.length > 0 ? <StatusBadge label={`${o.needsUs.length} open`} /> : undefined}
          hint="Items only this company can clear — confirm a payment, triage a request, send a drafted agreement. Nothing else in the ERP surfaces these."
        >
          <ClientBallList
            items={o.needsUs}
            empty="Nothing is waiting on us for this client."
            staleAfterDays={STALE_AFTER_DAYS}
            today={today}
          />
        </Card>
        <Card
          title="Waiting on the client"
          headerRight={o.needsClient.length > 0 ? <StatusBadge label={`${o.needsClient.length} open`} /> : undefined}
          hint="What the client portal is currently asking them for. Shown so a chase is an informed decision rather than a guess."
        >
          <ClientBallList
            items={o.needsClient}
            empty="Nothing is outstanding with the client."
            today={today}
          />
        </Card>
      </div>

      <div className="ch-tiles">
        <KpiTile
          label="Active projects"
          value={String(o.projects.active)}
          foot={o.projects.total === o.projects.active ? undefined : `${o.projects.total} total`}
        />
        <KpiTile
          label="Portfolio progress"
          value={`${o.projects.percent}%`}
          hint="Mean of each project's own progress — not all tasks pooled, so a large project cannot drown out a small one."
        />
        <KpiTile
          label="Open tasks"
          value={String(o.tasks.open)}
          foot={o.tasks.overdue > 0 ? `${o.tasks.overdue} overdue` : undefined}
          deltaUp={false}
        />
        <KpiTile
          label="Deliverables"
          value={`${o.deliverables.delivered}/${o.deliverables.total}`}
          foot={o.deliverables.overdue > 0 ? `${o.deliverables.overdue} overdue` : undefined}
        />
        {money ? (
          <KpiTile
            label="Outstanding"
            value={`${money.currency} ${money.outstanding.toLocaleString()}`}
            foot={
              money.pendingConfirmation > 0
                ? `${money.pendingConfirmation.toLocaleString()} awaiting confirmation`
                : money.overdueCount > 0
                  ? `${money.overdueCount} invoice${money.overdueCount === 1 ? "" : "s"} overdue`
                  : undefined
            }
            hint="Invoiced minus CONFIRMED payments. A client-recorded transfer does not move this figure until someone confirms it."
          />
        ) : (
          <KpiTile label="Outstanding" value="—" foot="no invoices" />
        )}
      </div>

      {o.money.byCurrency.length > 1 && (
        <Card title="Money by currency" hint="Never summed across currencies — a combined total is wrong in a way nobody notices until it is quoted back at you.">
          <div style={{ display: "grid", gap: 8 }}>
            {o.money.byCurrency.map((m) => (
              <div key={m.currency} style={{ display: "flex", gap: 16, font: "400 13px var(--font-body)" }}>
                <strong style={{ minWidth: 48 }}>{m.currency}</strong>
                <span>invoiced {m.invoiced.toLocaleString()}</span>
                <span>paid {m.paid.toLocaleString()}</span>
                <span style={{ color: "var(--ink-strong)", fontWeight: 500 }}>outstanding {m.outstanding.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {o.nextMilestone && (
        <Card title="Next commitment">
          <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)" }}>
            <strong>{o.nextMilestone.name}</strong>
            {o.nextMilestone.dueDate ? ` · due ${formatDate(o.nextMilestone.dueDate)}` : ""}
            {" · "}
            <Link href={`/projects/${o.nextMilestone.projectId}`} style={{ color: "var(--erp-accent)", textDecoration: "none" }}>
              {o.nextMilestone.projectName}
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
