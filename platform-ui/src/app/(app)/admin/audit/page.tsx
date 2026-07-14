import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getAudit, type AuditEntry, type AuditFilters } from "@/lib/adminData";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

const SUBTITLE =
  "Every state-changing action across the tenant — who did what, to which record, and when.";

// Next 15: searchParams is async.
type SP = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function limitedState() {
  return (
    <>
      <PageHeader eyebrow="Admin" title="Audit" subtitle={SUBTITLE} />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
          This page is limited to administrators.
        </p>
      </Card>
    </>
  );
}

export default async function AdminAuditPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Admin" title="Audit" subtitle={SUBTITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const verb = one(sp.verb);
  const entityType = one(sp.entityType);
  const actorId = one(sp.actorId);
  const since = one(sp.since);
  const until = one(sp.until);
  const limit = Math.max(10, Math.min(500, Number(one(sp.limit)) || 50));

  const filters: AuditFilters = {
    verb: verb || undefined,
    entityType: entityType || undefined,
    actorId: actorId || undefined,
    since: since ? new Date(since).toISOString() : undefined,
    until: until ? new Date(until).toISOString() : undefined,
    limit,
  };

  let entries: AuditEntry[];
  try {
    entries = await getAudit(userId, tenant, filters);
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return limitedState();
    throw e;
  }

  // Distinct verbs / entity types from what came back — good-enough filter
  // options until the backend exposes a facets endpoint.
  const verbs = Array.from(new Set(entries.map((r) => r.verb).filter(Boolean))).sort();
  const entityTypes = Array.from(new Set(entries.map((r) => r.target_entity_type).filter(Boolean))).sort();

  const rows = entries.map((r) => [
    r.actor_name ?? r.actor_id ?? "System",
    <StatusBadge key="v" label={r.verb || "—"} />,
    r.target_entity_type ? `${r.target_entity_type}${r.target_entity_id ? ` · ${r.target_entity_id}` : ""}` : "—",
    formatWhen(r.occurred_at),
  ]);

  const reachedLimit = entries.length >= limit;

  return (
    <>
      <PageHeader eyebrow="Admin" title="Audit" subtitle={SUBTITLE} />

      <Card style={{ marginBottom: 20 }}>
        <form className="lux-filters" method="get" aria-label="Audit filters">
          <label className="lux-filters__field">
            <span>Verb</span>
            <select name="verb" defaultValue={verb}>
              <option value="">All</option>
              {verbs.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="lux-filters__field">
            <span>Entity type</span>
            <select name="entityType" defaultValue={entityType}>
              <option value="">All</option>
              {entityTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="lux-filters__field">
            <span>From</span>
            <input type="date" name="since" defaultValue={since} />
          </label>
          <label className="lux-filters__field">
            <span>To</span>
            <input type="date" name="until" defaultValue={until} />
          </label>
          <input type="hidden" name="limit" value={String(limit)} />
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
            <a href="/admin/audit" className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
          </div>
        </form>
      </Card>

      <Card title={`Activity${entries.length ? ` · ${entries.length}` : ""}`}>
        {entries.length === 0 ? (
          <EmptyNote>No audit entries match these filters.</EmptyNote>
        ) : (
          <>
            <HairlineTable
              columns={[{ label: "Actor" }, { label: "Action" }, { label: "Record" }, { label: "When", align: "right" }]}
              rows={rows}
              tcols="1.4fr 0.9fr 1.6fr 1fr"
            />
            {reachedLimit && (
              <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
                <a
                  href={`/admin/audit?${new URLSearchParams({
                    ...(verb ? { verb } : {}),
                    ...(entityType ? { entityType } : {}),
                    ...(since ? { since } : {}),
                    ...(until ? { until } : {}),
                    limit: String(limit + 50),
                  }).toString()}`}
                  className="lux-btn lux-btn--ghost lux-btn--sm"
                >
                  Load more
                </a>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
