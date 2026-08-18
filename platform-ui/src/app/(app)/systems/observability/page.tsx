import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import {
  getObservability,
  fmt,
  utilLevel,
  levelLabel,
  diskProjectionNote,
} from "@/lib/observability";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Observability" };
export const dynamic = "force-dynamic";

// PLANE A — this box, staff only. The client-facing property monitoring is /monitoring (Plane B),
// a different module with different tenancy; the two never merge (monitoring-program.md §8.1).
//
// Deliberately a SUMMARY, not a Grafana replacement. It answers "is the server healthy right now"
// without an SSH tunnel — which until now was the only way to see any of this, and is why a fully
// broken datastore exporter sat unnoticed. Deep analysis stays in Grafana.

export default async function ObservabilityPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const snap = await getObservability(userId);

  // null = 403/404. "You may not see this" is NOT "the box is unmonitored", so it gets its own words.
  if (!snap) {
    return (
      <>
        <PageHeader title="Observability" subtitle="Platform infrastructure health" />
        <EmptyNote>
          This console is restricted to platform administrators, or the endpoint is not deployed on
          the running backend yet. Metrics are unaffected either way — this is a visibility gate, not
          a monitoring outage.
        </EmptyNote>
      </>
    );
  }

  if (!snap.available) {
    return (
      <>
        <PageHeader title="Observability" subtitle="Platform infrastructure health" />
        <EmptyNote>
          <strong>Cannot read this box&apos;s metrics.</strong> {snap.reason}
          <br />
          Full dashboards: <code>{snap.grafanaHint}</code>
        </EmptyNote>
      </>
    );
  }

  const h = snap.host;
  const cpu = utilLevel(h?.cpuBusyPct.value ?? null);
  const mem = utilLevel(h?.memUsedPct.value ?? null);
  const disk = utilLevel(h?.diskUsedPct.value ?? null);
  const diskNote = h ? diskProjectionNote(h.diskFreeGb, h.diskFreeGb24h) : null;

  const pgDown = (snap.datastores?.postgres ?? []).filter((d) => !d.up);
  const redisDown = (snap.datastores?.redis ?? []).filter((d) => !d.up);

  return (
    <>
      <PageHeader
        title="Observability"
        subtitle={`This box's own health — read ${formatDateTime(snap.collectedAt)}`}
      />

      {/* Anything genuinely wrong is stated ABOVE the tiles. A reader who stops at the first
          screenful must not come away thinking everything is fine. */}
      {(snap.targets?.down ?? 0) > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {snap.targets?.down} scrape target{snap.targets?.down === 1 ? "" : "s"} down
            {snap.targets?.downJobs.length ? ` — ${snap.targets.downJobs.join(", ")}` : ""}. Metrics
            from {snap.targets?.down === 1 ? "it" : "them"} are missing, so anything computed from
            those series is incomplete rather than good.
          </EmptyNote>
        </div>
      )}
      {(pgDown.length > 0 || redisDown.length > 0) && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {[
              ...pgDown.map((d) => `Postgres (${d.instance})`),
              ...redisDown.map((d) => `Redis (${d.instance})`),
            ].join(", ")}{" "}
            unreachable from the exporter. Check the exporter&apos;s DSN before concluding the
            datastore is down — a wrong host or password reports identically to a real outage.
          </EmptyNote>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          marginBottom: 20,
        }}
      >
        <KpiTile
          label="CPU busy"
          value={fmt(h?.cpuBusyPct, "%")}
          foot={cpu === "unknown" ? "no data" : undefined}
        />
        <KpiTile label="Memory used" value={fmt(h?.memUsedPct, "%")} />
        <KpiTile
          label="Disk used"
          value={fmt(h?.diskUsedPct, "%")}
          foot={h?.diskFreeGb.value !== null ? `${fmt(h?.diskFreeGb)} GB free` : "no data"}
          hint="Alerts fire below 15% free. This tile and the DiskSpaceLow alert use the same query, so they cannot disagree."
        />
        <KpiTile label="Load (1m)" value={fmt(h?.load1)} />
        <KpiTile label="Uptime" value={fmt(h?.uptimeDays, "d")} />
        <KpiTile
          label="Scrape targets"
          value={snap.targets ? `${snap.targets.up}/${snap.targets.up + snap.targets.down}` : "—"}
          foot="up / total"
          hint="A target being up means the exporter answered. It does NOT mean the thing it measures is healthy — see the datastore rows below."
        />
      </div>

      {diskNote && (
        <div style={{ marginBottom: 20 }}>
          <StatusBadge label={diskNote.startsWith("projected") ? "critical" : "at risk"} />{" "}
          <span style={{ fontSize: 13 }}>Disk {diskNote}.</span>
        </div>
      )}

      <Card title="Resource pressure" hint="Tiers match the alert thresholds, so the console and the pager agree.">
        <HairlineTable
          columns={[{ label: "Resource" }, { label: "Value", align: "right" }, { label: "State" }]}
          rows={[
            ["CPU", fmt(h?.cpuBusyPct, "%"), <StatusBadge key="c" label={levelLabel(cpu)} />],
            ["Memory", fmt(h?.memUsedPct, "%"), <StatusBadge key="m" label={levelLabel(mem)} />],
            ["Disk", fmt(h?.diskUsedPct, "%"), <StatusBadge key="d" label={levelLabel(disk)} />],
          ]}
        />
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card
          title="Datastores"
          hint="Reported by the exporters, per instance. This estate runs two Postgres and two Redis."
        >
          {(snap.datastores?.postgres.length ?? 0) + (snap.datastores?.redis.length ?? 0) === 0 ? (
            <EmptyNote>
              No datastore metrics at all — the exporters are not reporting. That is a blind spot,
              not a clean bill of health.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Datastore" }, { label: "Instance" }, { label: "State" }]}
              rows={[
                ...(snap.datastores?.postgres ?? []).map((d, i) => [
                  "Postgres",
                  d.instance,
                  <StatusBadge key={`p${i}`} label={d.up ? "active" : "critical"} />,
                ]),
                ...(snap.datastores?.redis ?? []).map((d, i) => [
                  "Redis",
                  d.instance,
                  <StatusBadge key={`r${i}`} label={d.up ? "active" : "critical"} />,
                ]),
              ]}
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card
          title="Firing alerts"
          hint="The always-on Watchdog heartbeat is excluded — showing it would put a permanent red on a healthy box."
        >
          {(snap.alerts ?? []).length === 0 ? (
            <EmptyNote>Nothing firing.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Alert" }, { label: "Severity" }]}
              rows={(snap.alerts ?? []).map((a, i) => [
                a.name,
                <StatusBadge key={`a${i}`} label={a.severity === "page" ? "critical" : "at risk"} />,
              ])}
            />
          )}
        </Card>
      </div>

      <p style={{ marginTop: 20, fontSize: 13, opacity: 0.7 }}>
        This is a summary. Dashboards, log search and traces live in Grafana:{" "}
        <code>{snap.grafanaHint}</code>. Client website monitoring is a separate surface under
        Business → Monitoring.
      </p>
    </>
  );
}
