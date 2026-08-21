import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listPipelineRuns, listInternalPendingGates, GATE_LABEL, RUN_STATUSES } from "@/lib/pipeline";
import { listRecordings } from "@/lib/meetings";
import { listClients, listProjects } from "@/lib/entities";
import { decideGateAction } from "@/lib/pipelineActions";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { DataTable, type Column } from "@/components/data/DataTable";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { StartRunPanel } from "@/components/pipeline/StartRunPanel";
import { formatDateTime } from "@/lib/format";

// Next 15: searchParams is async.
type SP = Promise<{ status?: string; clientId?: string }>;

const COLUMNS: Column[] = [
  { key: "title", header: "Run", sortable: true },
  { key: "client", header: "Client", sortable: true },
  { key: "meeting", header: "Meeting", sortable: true },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
  { key: "started", header: "Started", format: "datetime", sortable: true, align: "right" },
];

// WS11 build item 6 — internal delivery-pipeline dashboard + review inbox. Runs across the three
// tracks + the gates awaiting internal (PM/UI/web-dev) review. Client-facing sign-offs live in the
// client portal. Degrades gracefully (empty states) until runs exist / the backend is deployed.
export default async function PipelinePage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return <EmptyNote>Select a company to see its delivery pipeline.</EmptyNote>;
  }
  const { status, clientId: clientFilter } = await searchParams;

  // C1: real filters, passed straight through to the backend's own query params
  // (pipeline.controller.ts's listRuns takes status + clientId). Narrowing SERVER-side matters here:
  // the alternative is fetching the 200-row cap and hiding most of it in the browser, which stops
  // being a filter the moment there are more than 200 runs. Search + sort over the returned page are
  // DataTable's, which is the right place for them.
  const [runs, gates, recordings, clients, projects] = await Promise.all([
    listPipelineRuns(userId, tenant, { status: status || undefined, clientId: clientFilter || undefined }),
    listInternalPendingGates(userId, tenant),
    // Still fetched, but only for the MEETING title column now — not to reconstruct the client.
    // AGN-3: recordings ENRICH this view (a crumb/link), they are not its subject. A refusal here
    // means the enrichment cannot be built, and the primary content still renders — so it is
    // unwrapped rather than surfaced. Recorded explicitly because an undocumented unwrap is how the
    // silent-empty defect spread in the first place.
    listRecordings(userId, tenant).then((r) => (r.kind === "ok" ? r.data : [])),
    listClients(userId, tenant),
    listProjects(userId, tenant),
  ]);
  const mayDecide = can(me, "approvals.decide", tenant);

  const clientNameById = new Map(clients.map((c) => [c.id, c.name]));
  const clientIdByMeetingId = new Map(recordings.filter((r) => r.client_id).map((r) => [r.meeting_id, r.client_id as string]));
  const recordingTitleByMeetingId = new Map(recordings.map((r) => [r.meeting_id, r.title]));

  const rows = runs.map((r) => {
    // C4 closed the reason this used to be a cross-reference: the list SELECT now returns client_id
    // directly, so a run created WITHOUT a meeting (or whose meeting is gone) still shows its client.
    // The meeting-derived lookup is kept only as a fallback for a server on an older tag, where the
    // field is simply absent from the response.
    const clientId = r.client_id ?? (r.source_meeting_id ? clientIdByMeetingId.get(r.source_meeting_id) : undefined);
    return {
      id: r.id,
      title: r.title ?? "(untitled)",
      client: clientId ? clientNameById.get(clientId) ?? null : null,
      meeting: r.source_meeting_id ? (recordingTitleByMeetingId.get(r.source_meeting_id) ?? r.source_meeting_id) : null,
      status: r.status,
      started: r.created_at,
    };
  });
  const hasUnresolvedClient = rows.some((r) => r.client == null);
  // Form actions must resolve to void; the typed result is consumed for revalidation only (MVP).
  async function onDecide(formData: FormData) {
    "use server";
    await decideGateAction(formData);
  }

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Delivery Pipeline" }]} />
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Delivery</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Delivery Pipeline</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "var(--ink-muted)", maxWidth: 620 }}>
          Every meeting-to-delivery run and its three tracks (delivery · report · scope). Reviews awaiting your
          decision appear below; client sign-offs happen in the client portal.
        </p>
      </div>

      <Card title="Awaiting internal review" headerRight={<span className="dash-pending-chip">{gates.length} PENDING</span>}>
        {gates.length === 0 ? (
          <EmptyNote>No prototypes or builds waiting on your review.</EmptyNote>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {gates.map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 14px", border: "1px solid var(--line-soft)", borderRadius: 12 }}>
                <div>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{GATE_LABEL[g.kind] ?? g.kind}</div>
                  <div style={{ font: "400 13px/1.4 var(--font-body)", color: "var(--ink-subtle)" }}>
                    Run {g.run_id.slice(0, 8)} · opened {formatDateTime(g.created_at)}
                    {g.note ? ` · ${g.note}` : ""}
                  </div>
                </div>
                {mayDecide ? (
                  <form action={onDecide} style={{ display: "flex", gap: 8 }}>
                    <input type="hidden" name="gateId" value={g.id} />
                    <button type="submit" name="decision" value="approved" className="btn btn-primary" style={{ fontSize: 13 }}>Approve</button>
                    <button type="submit" name="decision" value="changes_requested" className="btn" style={{ fontSize: 13 }}>Request changes</button>
                  </form>
                ) : (
                  <StatusBadge label="review pending" />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {mayDecide && (
        <div style={{ marginTop: 28 }}>
          <Card title="Start a run · repair links">
            <StartRunPanel
              clients={clients.map((c) => ({ id: c.id, name: c.name }))}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            />
          </Card>
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <Card style={{ marginBottom: 20 }}>
          <form className="lux-filters" method="get" aria-label="Run filters">
            <label className="lux-filters__field">
              <span>Status</span>
              <select name="status" defaultValue={status ?? ""}>
                <option value="">All</option>
                {RUN_STATUSES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </label>
            {/* C1: filtering by client is the question a PM actually asks of this list ("what is
                running for Nusa Coffee?"), and it is answered by the backend, not by hiding rows. */}
            <label className="lux-filters__field">
              <span>Client</span>
              <select name="clientId" defaultValue={clientFilter ?? ""}>
                <option value="">All clients</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <div className="lux-filters__actions">
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
              <a href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
            </div>
          </form>
        </Card>

        <Card title={`Runs${runs.length ? ` · ${runs.length}` : ""}`}>
          {runs.length === 0 ? (
            <EmptyNote>{status ? "No runs match that status." : "No pipeline runs yet. They appear here once a meeting is dispatched."}</EmptyNote>
          ) : (
            <>
              <DataTable
                columns={COLUMNS}
                rows={rows}
                link={{ base: "/pipeline", idKey: "id", labelKey: "title" }}
                searchKeys={["title", "client", "meeting", "status"]}
                pageSize={20}
                csvName="pipeline-runs"
                empty="No pipeline runs yet."
              />
              {hasUnresolvedClient && (
                <p style={{ margin: "14px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
                  Client is blank only for a run genuinely not attached to one — created directly, or
                  started from a meeting that had no client. The list now carries the client itself, so
                  this is no longer a display limitation: it means the run really has no client, and it
                  will not appear in any client portal until one is set.
                </p>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
