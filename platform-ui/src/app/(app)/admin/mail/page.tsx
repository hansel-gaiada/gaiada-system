import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { listMailLog, entityHref, type MailLogFilters } from "@/lib/mail";
import { parseSinceParam } from "@/lib/mailFilters";
import { MailStatusChip } from "@/components/mail/MailStatusChip";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDateTime } from "@/lib/format";
import Link from "next/link";

// MAIL-15 — the admin mail log list (design §8A, contract §17). Elevated-only on the backend
// (`GET /api/admin/mail/log` — `isElevated`, 403 for anyone else); this page mirrors the audit
// page's convention of propagating a 403 into a "limited to administrators" state rather than a
// crash or a silently-empty list.
const SUBTITLE =
  "Every outbound + inbound mail row the platform has queued, sent, or received — status chips " +
  "render what actually happened, not what a provider claims.";

type SP = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

const STREAMS = ["notify", "auth"];
const STATUSES = ["queued", "sending", "sent", "delivered", "bounced", "failed", "suppressed"];

function limitedState() {
  return (
    <>
      <PageHeader eyebrow="Settings" title="Mail" subtitle={SUBTITLE} />
      <Card>
        <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
          This page is limited to administrators.
        </p>
      </Card>
    </>
  );
}

// MAIL-34 defect 1 — a malformed `tenantId`/`entityId`/`since` used to propagate as an uncaught
// 400 (or, for `since`, an even earlier client-side RangeError — see `lib/mailFilters.ts`) into
// Next's generic "Something went wrong" boundary. `status`/`stream` are unvalidated text columns
// and already degrade gracefully to the "no matches" EmptyNote below — this card is the same
// gentle treatment for the fields that DO get validated, so the two paths read as one design
// instead of one crashing and one not. Rendered inside the filters form's own Card region so the
// bad value stays visible and editable, exactly where the user typed it.
function filterErrorCard(message: string) {
  return (
    <Card title="Log">
      <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--status-critical-fg)" }}>
        {message}. Adjust the filter above and apply again.
      </p>
    </Card>
  );
}

export default async function AdminMailPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  await getMe(userId); // resolves the session; the read below is what actually gates access

  const sp = await searchParams;
  const stream = one(sp.stream);
  const status = one(sp.status);
  const tenantId = one(sp.tenantId);
  const entityType = one(sp.entityType);
  const entityId = one(sp.entityId);
  const since = one(sp.since);
  const limit = Math.max(10, Math.min(500, Number(one(sp.limit)) || 100));

  // MAIL-34 defect 1 — parses WITHOUT ever throwing (see lib/mailFilters.ts's header for why the
  // previous `new Date(since).toISOString()` here crashed on a hand-edited `?since=` before the
  // request even reached the BFF).
  const sinceParsed = parseSinceParam(since);

  const filters: MailLogFilters = {
    stream: stream || undefined,
    status: status || undefined,
    tenantId: tenantId || undefined,
    entityType: entityType || undefined,
    entityId: entityId || undefined,
    since: sinceParsed.iso,
    limit,
  };

  let page: Awaited<ReturnType<typeof listMailLog>> | null = null;
  let filterError: string | null = null;
  if (sinceParsed.invalid) {
    filterError = "\"since\" isn't a date this filter understands";
  } else {
    try {
      page = await listMailLog(userId, filters);
    } catch (e) {
      if (e instanceof PlatformError && e.status === 403) return limitedState();
      if (e instanceof PlatformError && e.status === 400) filterError = e.message;
      else throw e;
    }
  }

  const rows = (page?.rows ?? []).map((r) => {
    const href = entityHref(r.entity_type, r.entity_id);
    return [
      <MailStatusChip key="s" status={r.status} />,
      r.stream,
      r.to_email,
      r.template_key,
      href ? (
        <Link key="e" href={href}>{r.entity_type}</Link>
      ) : (
        r.entity_type ?? "—"
      ),
      formatDateTime(r.created_at),
      <Link key="d" href={`/admin/mail/${r.id}`} className="lux-btn lux-btn--ghost lux-btn--sm">
        View
      </Link>,
    ];
  });

  const reachedLimit = page != null && page.rows.length >= page.limit;

  return (
    <>
      <PageHeader eyebrow="Settings" title="Mail" subtitle={SUBTITLE} />

      <Card style={{ marginBottom: 20 }}>
        <form className="lux-filters" method="get" aria-label="Mail log filters">
          <label className="lux-filters__field">
            <span>Stream</span>
            <select name="stream" defaultValue={stream}>
              <option value="">All</option>
              {STREAMS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="lux-filters__field">
            <span>Status</span>
            <select name="status" defaultValue={status}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="lux-filters__field">
            <span>Tenant id</span>
            <input type="text" name="tenantId" defaultValue={tenantId} placeholder="uuid" />
          </label>
          <label className="lux-filters__field">
            <span>Entity type</span>
            <input type="text" name="entityType" defaultValue={entityType} placeholder="pipeline_run" />
          </label>
          <label className="lux-filters__field">
            <span>Entity id</span>
            <input type="text" name="entityId" defaultValue={entityId} placeholder="uuid" />
          </label>
          <label className="lux-filters__field">
            <span>Since</span>
            <input type="date" name="since" defaultValue={since} />
          </label>
          <input type="hidden" name="limit" value={String(limit)} />
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
            <a href="/admin/mail" className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
          </div>
        </form>
      </Card>

      {filterError != null ? (
        filterErrorCard(filterError)
      ) : (
        <Card title={`Log${page && page.rows.length ? ` · ${page.rows.length}` : ""}`}>
          {!page || page.rows.length === 0 ? (
            <EmptyNote>No mail matches these filters.</EmptyNote>
          ) : (
            <>
              <HairlineTable
                columns={[
                  { label: "Status" },
                  { label: "Stream" },
                  { label: "To" },
                  { label: "Template" },
                  { label: "Entity" },
                  { label: "Queued", align: "right" },
                  { label: "" },
                ]}
                rows={rows}
                tcols="1.2fr 0.7fr 1.4fr 1.2fr 1.2fr 1fr 0.6fr"
              />
              {reachedLimit && (
                <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
                  <a
                    href={`/admin/mail?${new URLSearchParams({
                      ...(stream ? { stream } : {}),
                      ...(status ? { status } : {}),
                      ...(tenantId ? { tenantId } : {}),
                      ...(entityType ? { entityType } : {}),
                      ...(entityId ? { entityId } : {}),
                      ...(since ? { since } : {}),
                      limit: String(limit + 100),
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
      )}
    </>
  );
}
