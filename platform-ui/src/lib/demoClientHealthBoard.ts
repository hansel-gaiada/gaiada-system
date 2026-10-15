import "server-only";
// DEMO_MODE only. The staff client-health BOARD (BFF §54.2, `GET :t/clients/health`, PV7-05).
//
// The state of every row comes from `evaluateClientHealth` (`clientHealthRules.ts`), the UI mirror of the backend rules
// that the golden table pins, so the demo cannot show a state the rules would not give for the same signals. The signals
// are fixtures RELATIVE TO `now` (ages in days or hours ago), so the board does not rot into "everything is off track".
//
// Seven clients cover every state:
//   off_track  Northwind Traders (cl-1: 15 days waiting on us), Orchard Dental (an invoice 40 days overdue, a site down 30 h)
//   at_risk    Cedar Group (cl-2: late milestones), Harbour Coffee Co (invoice 20 days overdue, a site incident open 5 h)
//   on_track   Lumen Studio (cl-3), Tidewater Hotels (monitoring off for the company)
//   quiet      Viceroy (cl-4: no active work)
// The first four ids are the demo's real clients, so a row opens a real hub page. The other three are board-only: they
// have no hub page in demo mode (the hub 404s on them), which is a fixture limit, not a contract fact.
//
// DEGRADED variant (`degraded: true`, served for the company `co-resort`): the `site` source "could not be read". Exactly as
// the backend does, `site` is null for EVERY row and named in `unavailable[]`, and a row that would have read On track or
// Quiet reads Unknown (reason `source_unavailable`); a row with a real finding keeps it. That is what makes Unknown
// drivable in the browser without lying about how it arises.
import type { Aged, ClientHealthBoard, ClientHealthRow, ClientHealthSignals, DueAged, HealthSource } from "./clientHealth";
import { evaluateClientHealth } from "./clientHealthRules";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface Spec {
  clientId: string; name: string; status: string; owner: [string, string] | null;
  waitingOnUs?: Aged; waitingOnClient?: Aged; lateDeliverables?: DueAged; lateMilestones?: DueAged; overdueInvoices?: DueAged;
  site?: { openIncidents: number; oldestOpenHoursAgo: number | null; uptime30d: number | null } | "off";
  openChangeRequests?: number; conversations?: number; activeProjects: number; activeServices?: number; onTime: number | null;
}

const SPECS: Spec[] = [
  { clientId: "cl-1", name: "Northwind Traders", status: "active", owner: ["u-pm", "Priya Mehta"],
    waitingOnUs: { count: 3, oldestSince: "-15d" }, waitingOnClient: { count: 1, oldestSince: "-3d" },
    lateDeliverables: { count: 1, oldestDue: "-5d" }, openChangeRequests: 1, conversations: 1,
    site: { openIncidents: 0, oldestOpenHoursAgo: null, uptime30d: 99.95 }, activeProjects: 1, onTime: 0.6 },
  { clientId: "cl-2", name: "Cedar Group", status: "active", owner: ["u-pm", "Priya Mehta"],
    waitingOnUs: { count: 1, oldestSince: "-2d" }, lateMilestones: { count: 2, oldestDue: "-4d" }, openChangeRequests: 0, conversations: 0,
    site: { openIncidents: 0, oldestOpenHoursAgo: null, uptime30d: 100 }, activeProjects: 1, onTime: 0.9 },
  { clientId: "cl-3", name: "Lumen Studio", status: "prospect", owner: ["u-dev", "Dewi Anggraini"],
    waitingOnClient: { count: 1, oldestSince: "-5d" }, openChangeRequests: 0, conversations: 0,
    site: { openIncidents: 0, oldestOpenHoursAgo: null, uptime30d: 99.99 }, activeProjects: 1, onTime: 1 },
  { clientId: "cl-4", name: "Viceroy", status: "active", owner: null, openChangeRequests: 0, conversations: 0,
    site: { openIncidents: 0, oldestOpenHoursAgo: null, uptime30d: null }, activeProjects: 0, onTime: null },
  { clientId: "cl-health-5", name: "Harbour Coffee Co", status: "active", owner: ["u-dev", "Dewi Anggraini"],
    overdueInvoices: { count: 1, oldestDue: "-20d" }, openChangeRequests: 2, conversations: 0,
    site: { openIncidents: 1, oldestOpenHoursAgo: 5, uptime30d: 98.7 }, activeProjects: 2, onTime: 0.75 },
  { clientId: "cl-health-6", name: "Orchard Dental", status: "active", owner: ["u-pm", "Priya Mehta"],
    overdueInvoices: { count: 2, oldestDue: "-40d" }, openChangeRequests: 0, conversations: 2,
    site: { openIncidents: 1, oldestOpenHoursAgo: 30, uptime30d: 94.2 }, activeProjects: 1, onTime: 0.5 },
  { clientId: "cl-health-7", name: "Tidewater Hotels", status: "active", owner: null, openChangeRequests: 0, conversations: 0,
    site: "off", activeProjects: 3, activeServices: 1, onTime: 0.95 },
];

const resolve = (rel: string | null, now: Date): string | null => {
  if (rel === null) return null;
  const m = /^-(\d+)d$/.exec(rel);
  return m ? new Date(now.getTime() - Number(m[1]) * DAY_MS).toISOString() : rel;
};
const dueOf = (rel: string, now: Date): string => (resolve(rel, now) as string).slice(0, 10);

export function buildDemoClientHealthBoard(now: Date, opts: { degraded?: boolean } = {}): ClientHealthBoard {
  const degraded = opts.degraded === true;
  const unavailable: HealthSource[] = degraded ? ["site"] : [];
  const clients = SPECS.map((s): ClientHealthRow => {
    const waitingOnUs = s.waitingOnUs ? { count: s.waitingOnUs.count, oldestSince: resolve(s.waitingOnUs.oldestSince, now) } : { count: 0, oldestSince: null };
    const waitingOnClient = s.waitingOnClient ? { count: s.waitingOnClient.count, oldestSince: resolve(s.waitingOnClient.oldestSince, now) } : { count: 0, oldestSince: null };
    const dueAged = (d?: DueAged): DueAged => (d ? { count: d.count, oldestDue: d.oldestDue ? dueOf(d.oldestDue, now) : null } : { count: 0, oldestDue: null });
    const site: ClientHealthSignals["site"] =
      degraded || s.site === "off" || s.site === undefined ? null
        : { openIncidents: s.site.openIncidents, oldestOpenSince: s.site.oldestOpenHoursAgo === null ? null : new Date(now.getTime() - s.site.oldestOpenHoursAgo * HOUR_MS).toISOString(), uptime30d: s.site.uptime30d };
    const signals: ClientHealthSignals = {
      waitingOnUs, waitingOnClient,
      lateDeliverables: dueAged(s.lateDeliverables), lateMilestones: dueAged(s.lateMilestones),
      openChangeRequests: s.openChangeRequests ?? 0, conversationsAwaitingReply: s.conversations ?? 0,
      overdueInvoices: dueAged(s.overdueInvoices), site,
      deliveryOnTime: s.onTime, activeProjects: s.activeProjects, activeServices: s.activeServices ?? 0,
    };
    const verdict = evaluateClientHealth(
      {
        waitingOnUs, waitingOnClient, lateDeliverables: signals.lateDeliverables, lateMilestones: signals.lateMilestones,
        overdueInvoices: signals.overdueInvoices, site: site ? { openIncidents: site.openIncidents, oldestOpenSince: site.oldestOpenSince } : null,
        activeProjects: signals.activeProjects, activeServices: signals.activeServices,
      },
      unavailable, now,
    );
    return {
      clientId: s.clientId, name: s.name, status: s.status,
      ownerUserId: s.owner?.[0] ?? null, ownerName: s.owner?.[1] ?? null,
      state: verdict.state, reasons: verdict.reasons, signals,
    };
  });
  return { asOf: now.toISOString(), onTimeKnownSince: "2026-10-15T09:00:00.000Z", clients, unavailable };
}
