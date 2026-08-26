import Link from "next/link";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { listClients, listProjects, type Client, type Project } from "@/lib/entities";
import { resolveGmTab, GmTabRefusal } from "@/components/departments/gm/gmTab";
import { GmMoneyCard } from "@/components/departments/gm/GmMoneyCard";

type Params = Promise<{ deptId: string }>;

const TITLE = "Clients & Money";

// GM console → Oversight → Clients & Money (GM-08).
//
// ── BOTH HALVES ARE REAL NOW (GM-09 unblocked, 2026-08-26) ───────────────────────────────────────
//   Portfolio half — `listClients` + `listProjects`. The join below is the GM-grain question
//                    ("which clients do we actually have work in flight for?") that neither /clients
//                    nor /project-management answers on its own.
//   Money half     — the FINANCE module's books: `finance/profit-and-loss` and `finance/ar/aging`,
//                    via `GmMoneyCard`.
//
// ⚠ THE HISTORY MATTERS, BECAUSE IT NEARLY WENT THE OTHER WAY. This half sat behind a
// `BackendPending` banner for the whole build, blocked as "no tenant-level spend endpoint exists".
// That was true, and the tempting fix — summing `engagements/:id/ledger` into a company figure — was
// ruled out by OQ-3, because that ledger is ONE department's search-marketing provider spend and
// presenting it as the group's money would have been a confident wrong answer a GM would quote in a
// review. Waiting was correct: a real double-entry finance module landed, and revenue and margin now
// come from the books at exactly the right grain. **Do not reintroduce the engagement-ledger
// shortcut** — it answers a different question and always did.
//
// Still true, and the reason `GmMoneyCard` leads with the `listPeriods` gate read: never a `0`. An
// empty list is a CLAIM, and "we earned nothing" is not one this console may make on the strength of
// a refused read or an unenabled module.

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

  // Month-to-date is the window for a money tab: a GM asking "are we making money?" on this surface
  // means the month in progress, not the current calendar week the cockpit shows. Stated in the tile
  // foot (`from → to`) rather than implied, so the two surfaces cannot be misread as disagreeing when
  // they legitimately report different windows.
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

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

      {/* `variant="full"` adds the worst-payer list; `explainRefusal` is TRUE here (unlike the
          cockpit, where the card simply disappears) because this is the tab a GM opens *to ask about
          money* — silence in answer to that question reads as breakage, where on the home screen it
          reads as tidiness. */}
      <GmMoneyCard
        userId={ctx.userId}
        tenantId={ctx.tenantId}
        from={monthStart}
        to={today}
        variant="full"
        explainRefusal
      />
    </>
  );
}

const KPI_ROW: React.CSSProperties = {
  display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 16,
};
const LINK: React.CSSProperties = { color: "var(--erp-accent)", textDecoration: "underline", textUnderlineOffset: 2 };
const NOTE: React.CSSProperties = { margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" };
