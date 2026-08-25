import Link from "next/link";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { listClients, listProjects, type Client, type Project } from "@/lib/entities";
import { resolveGmTab, GmTabRefusal } from "@/components/departments/gm/gmTab";

type Params = Promise<{ deptId: string }>;

const TITLE = "Clients & Money";

// GM console → Oversight → Clients & Money (GM-08).
//
// ── THE TWO HALVES ARE BLOCKED DIFFERENTLY, AND THAT IS THE POINT OF THIS FILE ────────────────────
//   Portfolio half — REAL. `listClients` + `listProjects` are live; the join below is the GM-grain
//                    question ("which clients do we actually have work in flight for?") that neither
//                    /clients nor /project-management answers on its own.
//   Money half     — NO BACKEND AT ALL. There is no tenant-level revenue, margin or month-to-date
//                    spend endpoint. Only `GET engagements/:id/ledger` exists, which is
//                    engagement-scoped and search-marketing-only. Owned by SM-17 (tenant-scope
//                    remainder) / SM-22, PENDING in BFF contract §14.
//
// ⚠ THE MONEY HALF MUST NOT BE FAKED BY SUMMING ENGAGEMENT LEDGERS. That ledger is search-marketing
// cost-to-serve at standard rates — ONE department's provider spend. Presenting it as the group's
// money would be a confident wrong answer of exactly the class this program keeps catching, and a GM
// would quote it in a review. Ruled OQ-3: the money half waits.
//
// So: a `BackendPending` banner naming the owning tickets, and never a `0`. An empty list is a CLAIM,
// and "we have no revenue" is not a claim this console is entitled to make.

/** A client is "active" when it has at least one project that is neither internal nor closed.
 *  Derived here rather than read off `client.status`: that field is the RECORD's lifecycle (a client
 *  can sit `active` for a year with nothing in flight), whereas what a GM means by an active client
 *  is one we are currently doing work for. Both are shown, and the column headers say which is which,
 *  because a mismatch between them is itself the interesting signal. */
const CLOSED_PROJECT_STATUSES = new Set(["done", "closed", "cancelled", "canceled", "archived"]);

function isLiveProject(p: Project): boolean {
  return !p.is_internal && !CLOSED_PROJECT_STATUSES.has(p.status.toLowerCase());
}

export default async function GmMoneyPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const ctx = await resolveGmTab(deptId);
  if (!ctx.ok) return <GmTabRefusal reason={ctx.reason} title={TITLE} />;

  // `listClients` swallows an unavailable endpoint into `[]` (`skipUnavailable`), so an empty client
  // list here cannot be distinguished from a dead endpoint — flagged rather than presented as fact.
  // `listProjects` throws, so it gets its own catch and its own tagged outcome.
  let projectsFailed = false;
  const [clients, projects] = await Promise.all([
    listClients(ctx.userId, ctx.tenantId),
    listProjects(ctx.userId, ctx.tenantId).catch(() => {
      projectsFailed = true;
      return [] as Project[];
    }),
  ]);

  const liveByClient = new Map<string, Project[]>();
  let unattributedLive = 0;
  for (const p of projects.filter(isLiveProject)) {
    if (!p.client_id) {
      // Client work with no client attached. Counted, not dropped: it is either a data-entry gap or
      // work nobody is going to bill, and both are things a GM should be told about.
      unattributedLive += 1;
      continue;
    }
    const list = liveByClient.get(p.client_id);
    if (list) list.push(p);
    else liveByClient.set(p.client_id, [p]);
  }

  const rows = clients
    .map((c: Client) => ({ client: c, live: liveByClient.get(c.id) ?? [] }))
    // Most work in flight first — the portfolio question is "where is our delivery concentrated",
    // and alphabetical order answers nothing.
    .sort((a, b) => b.live.length - a.live.length || a.client.name.localeCompare(b.client.name));

  const withWork = rows.filter((r) => r.live.length > 0);
  const idle = rows.filter((r) => r.live.length === 0);
  const internalLive = projects.filter((p) => p.is_internal && !CLOSED_PROJECT_STATUSES.has(p.status.toLowerCase())).length;

  return (
    <>
      <BackendPending
        what="Group revenue, margin and month-to-date spend have no endpoint yet — only per-engagement cost ledgers exist, and one department's provider spend is not the group's money."
        contract="GET /api/:t/… tenant-scoped spend (SM-17 / SM-22)"
      />

      <Card
        title="Client portfolio"
        headerRight={<Link href="/clients" className="lux-btn lux-btn--ghost lux-btn--sm">Clients</Link>}
      >
        {clients.length === 0 ? (
          <EmptyNote>
            No clients came back. This read degrades silently when the endpoint is unavailable, so
            treat it as &ldquo;unknown&rdquo; rather than &ldquo;none&rdquo; until Clients confirms it.
          </EmptyNote>
        ) : (
          <>
            <div style={KPI_ROW}>
              <KpiTile
                label="Clients with work in flight"
                value={String(withWork.length)}
                foot={`of ${clients.length} on the books`}
                hint="A client with at least one project that is neither internal nor closed. This is delivery activity, not the client record's own status field."
              />
              <KpiTile
                label="Live client projects"
                value={String([...liveByClient.values()].reduce((n, l) => n + l.length, 0))}
                foot={internalLive ? `plus ${internalLive} internal` : "no internal projects open"}
              />
              <KpiTile
                label="Dormant clients"
                value={String(idle.length)}
                foot={idle.length ? "on the books, nothing in flight" : "every client has work"}
                hint="Not a problem by itself — a retainer between engagements looks identical to a lapsed relationship here. It is a list to review, not a number to fix."
              />
            </div>
            <HairlineTable
              columns={[
                { label: "Client" },
                { label: "Record status" },
                { label: "Live projects", align: "right" },
                { label: "", align: "right" },
              ]}
              rows={rows.map(({ client, live }) => [
                client.name,
                <StatusBadge key="s" label={client.status} />,
                live.length === 0 ? "—" : String(live.length),
                <Link key="go" href={`/clients/${client.id}`} style={LINK}>Open</Link>,
              ])}
              tcols="2.2fr 1fr 1fr 0.7fr"
            />
            {projectsFailed && (
              <p style={NOTE}>
                <strong>The project read failed</strong>, so every &ldquo;live projects&rdquo; figure
                above is 0 by absence, not by fact.
              </p>
            )}
            {unattributedLive > 0 && (
              <p style={NOTE}>
                {unattributedLive} live client project{unattributedLive === 1 ? " has" : "s have"} no
                client attached, so {unattributedLive === 1 ? "it is" : "they are"} counted in the
                project total but in no client&rsquo;s row.
              </p>
            )}
          </>
        )}
      </Card>

      <Card title="Money" headerRight={<Link href="/billing" className="lux-btn lux-btn--ghost lux-btn--sm">Billing</Link>}>
        <EmptyNote>
          Revenue, margin and cost-to-serve are not shown because no tenant-level endpoint exists for
          them — see the banner above. They are deliberately left blank rather than filled with the
          SEO department&rsquo;s engagement ledger, which measures one department&rsquo;s provider
          spend and would read as the group&rsquo;s cost.
        </EmptyNote>
      </Card>
    </>
  );
}

const KPI_ROW: React.CSSProperties = {
  display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 16,
};
const LINK: React.CSSProperties = { color: "var(--erp-accent)", textDecoration: "underline", textUnderlineOffset: 2 };
const NOTE: React.CSSProperties = { margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" };
