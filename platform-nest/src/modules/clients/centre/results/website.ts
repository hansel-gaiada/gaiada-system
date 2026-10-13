// PV6-02 — the Website card: one card per site the client has (modules `webdev`, and `monitoring` for the probes).
//
// Two sources of "a site the client has":
//   * `webdev_sites` (module wall `webdev`): a registered domain. The probes are matched to it by HOST: an enabled
//     monitor of this client whose target host is the domain (or a subdomain of it) is a probe of this site.
//   * `webdesk_site_clients` (plain tenant wall): a WebDesk site linked to the client. The ERP holds only WebDesk's
//     opaque ids for it, no domain, so nothing can be attributed to it: its card lists the site and carries NO
//     KPIs (they cannot be measured yet). Linking a monitor to a WebDesk site is a follow-up (see the hand-back).
//
// The probe figures are read only when the company has the `monitoring` module enabled, in their own transaction
// that declares only `monitoring`. Uptime uses the SAME SQL text as the monitoring console (UPTIME_RATIO_SQL,
// exported from monitoring.controller.ts and pinned to runner.ts by uptime-parity.test.ts): maintenance and
// unknown checks leave both halves, degraded counts against, an empty window is NULL.
import { UPTIME_RATIO_SQL } from "../../../monitoring/monitoring.controller";
import { areaFor } from "./area-map";
import { isoDate, kpi, round } from "./kpi";
import type { BuildContext, Kpi, ResultsBuilder, ServiceCard } from "./types";

const DAY = 86_400_000;

interface SiteRow { domain: string; since: string }
interface MonitorRow { id: string; target: string | null; status: string; cert_expires_at: Date | null; domain_expires_at: Date | null }

/** The host of a monitor target: a URL's hostname, or the `host[:port]` of a tcp/tls target. Lowercased, no `www.`. */
export function hostOf(target: string | null): string | null {
  if (!target) return null;
  let h: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try { h = new URL(target).hostname; } catch { return null; }
  } else {
    const bracket = /^\[(.+)\](?::\d+)?$/.exec(target);
    h = bracket ? bracket[1] : (target.split(/[/:]/)[0] ?? "");
  }
  h = h.toLowerCase().replace(/\.$/, "");
  return h ? h.replace(/^www\./, "") : null;
}

/** Does a monitor aimed at `host` probe the site `domain`? Equal, or a subdomain of it. */
export function hostBelongsToDomain(host: string | null, domain: string): boolean {
  if (!host) return false;
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith(`.${d}`);
}

function liveState(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  if (statuses.includes("down")) return "Down";
  if (statuses.includes("degraded")) return "Slow";
  if (statuses.every((s) => s === "up")) return "Online";
  if (statuses.includes("maintenance")) return "Under maintenance";
  return null; // never checked / unknown: no claim
}

function daysUntil(d: Date | null, now: Date): number | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / DAY);
}

export const websiteBuilder: ResultsBuilder = {
  service: "website",
  requires: ["webdev"],
  async build(ctx: BuildContext): Promise<ServiceCard[]> {
    const sites = await ctx.read(["webdev"], async (c) => {
      const own = await c.query<SiteRow>(
        `SELECT domain, created_at::date::text AS since FROM webdev_sites
          WHERE client_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          ORDER BY created_at, domain`,
        [ctx.clientId, ctx.tenantId],
      );
      const linked = await c.query<{ since: string }>(
        `SELECT wsc.created_at::date::text AS since
           FROM webdesk_site_clients wsc
           JOIN clients cl ON cl.id = wsc.client_id AND cl.tenant_id = wsc.tenant_id AND cl.deleted_at IS NULL
          WHERE wsc.client_id = $1 AND wsc.tenant_id = $2
          ORDER BY wsc.created_at, wsc.site_id`,
        [ctx.clientId, ctx.tenantId],
      );
      return { own: own.rows, linked: linked.rows };
    });
    if (sites.own.length === 0 && sites.linked.length === 0) return [];

    const monitors = ctx.enabled.has("monitoring") && sites.own.length > 0
      ? await ctx.read(["monitoring"], async (c) => {
          const ms = await c.query<MonitorRow>(
            `SELECT id, target, status, cert_expires_at, domain_expires_at FROM monitors
              WHERE client_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND enabled
              ORDER BY created_at, id`,
            [ctx.clientId, ctx.tenantId],
          );
          const perSite = new Map<string, { uptime: number | null; uptimePrev: number | null; open: number; latest: string | null; ids: string[] }>();
          const from30 = new Date(ctx.now.getTime() - 30 * DAY).toISOString();
          const from60 = new Date(ctx.now.getTime() - 60 * DAY).toISOString();
          for (const s of sites.own) {
            const ids = ms.rows.filter((m) => hostBelongsToDomain(hostOf(m.target), s.domain)).map((m) => m.id);
            if (ids.length === 0) continue;
            const win = (a: string, b: string | null) => c.query<{ ratio: string | null; latest: Date | null }>(
              `SELECT ${UPTIME_RATIO_SQL} AS ratio, max(r.checked_at) AS latest
                 FROM monitor_results r
                WHERE r.tenant_id = $1 AND r.monitor_id = ANY($2::uuid[])
                  AND r.checked_at >= $3::timestamptz AND ($4::timestamptz IS NULL OR r.checked_at < $4::timestamptz)`,
              [ctx.tenantId, ids, a, b],
            );
            const cur = (await win(from30, null)).rows[0];
            const prev = (await win(from60, from30)).rows[0];
            const open = await c.query<{ n: string }>(
              `SELECT count(*) AS n FROM monitor_incidents WHERE tenant_id = $1 AND monitor_id = ANY($2::uuid[]) AND closed_at IS NULL`,
              [ctx.tenantId, ids],
            );
            const pct = (r: string | null | undefined) => (r === null || r === undefined ? null : round(Number(r) * 100, 2));
            perSite.set(s.domain, {
              uptime: pct(cur?.ratio), uptimePrev: pct(prev?.ratio), open: Number(open.rows[0]?.n ?? 0),
              latest: cur?.latest ? new Date(cur.latest).toISOString() : null, ids,
            });
          }
          return { monitors: ms.rows, perSite };
        })
      : null;

    const cards: ServiceCard[] = [];
    const total = sites.own.length + sites.linked.length;
    for (const s of sites.own) {
      const probe = monitors?.perSite.get(s.domain);
      const mine = probe ? monitors!.monitors.filter((m) => probe.ids.includes(m.id)) : [];
      const certDays = mine.map((m) => daysUntil(m.cert_expires_at, ctx.now)).filter((d): d is number => d !== null);
      const domainDays = mine.map((m) => daysUntil(m.domain_expires_at, ctx.now)).filter((d): d is number => d !== null);
      const asOf = isoDate(probe?.latest ?? null);
      const period = probe ? { from: isoDate(new Date(ctx.now.getTime() - 29 * DAY))!, to: isoDate(ctx.now)! } : null;
      const kpis: Kpi[] = [
        kpi("website.uptime_30d", "Uptime, last 30 days", "percent", probe?.uptime ?? null, { period, previous: probe?.uptimePrev ?? null, asOf }),
        kpi("website.open_incidents", "Open incidents", "count", probe ? probe.open : null, { asOf: isoDate(ctx.now) }),
        kpi("website.cert_days", "Days until the certificate expires", "count", certDays.length ? Math.min(...certDays) : null, { asOf: isoDate(ctx.now) }),
        kpi("website.domain_days", "Days until the domain expires", "count", domainDays.length ? Math.min(...domainDays) : null, { asOf: isoDate(ctx.now) }),
      ];
      cards.push({
        service: "website",
        areaId: areaFor("website"),
        title: total > 1 ? `Website: ${s.domain}` : "Website",
        status: "active",
        since: s.since,
        items: [{ label: s.domain, detail: liveState(mine.map((m) => m.status)) }],
        kpis,
        clientVisible: true,
      });
    }
    for (const l of sites.linked) {
      cards.push({
        service: "website",
        areaId: areaFor("website"),
        title: "Website content",
        status: "active",
        since: l.since,
        items: [{ label: "Managed website", detail: null }],
        // No KPIs, not null ones: null means "not measured yet" and these cannot be measured until a monitor->site link exists (follow-up).
        kpis: [],
        clientVisible: true,
      });
    }
    return cards;
  },
};
