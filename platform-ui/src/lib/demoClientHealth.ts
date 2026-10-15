import "server-only";
// DEMO_MODE only. The staff client-health read for ONE client (BFF §54.2, `GET :t/clients/:clientId/health`), built from
// the inputs `demoFixtures.ts` already holds (the client's projects, deliverables, invoices and the two ball lists of the
// hub overview), so the Health card agrees with the lists above it in the same demo session.
//
// Contract-exact: the field names and null rules are §54.2's. A pure function of its input, so it is unit-tested directly
// (`demoClientHealth.test.ts`) without the dispatch chain.
//
// THE STATE comes from `clientHealthRules.ts`, the UI mirror of the backend rules that the same golden table pins (PV7-05).
// Site incidents are not modelled here (`site: null`, "monitoring off for this company").
import { evaluateClientHealth } from "./clientHealthRules";
import type {
  ClientHealthDetail, DueAged, HealthSource, ProjectHealth, Turnaround, TurnaroundKind, TurnaroundPart,
} from "./clientHealth";

const DAY_MS = 86_400_000;

export interface DemoHealthInput {
  clientId: string;
  name: string;
  status: string;
  now: Date;
  /** The client's non-internal projects. */
  projects: Array<{ id: string; name: string; status: string }>;
  deliverables: Array<{ projectId: string; status: string; dueDate: string | null }>;
  invoices: Array<{ status: string; dueDate: string | null }>;
  needsUs: Array<{ since: string | null }>;
  needsClient: Array<{ since: string | null }>;
  conversationsAwaitingReply: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const offsetDay = (now: Date, days: number) => ymd(new Date(now.getTime() + days * DAY_MS));

/** Milestones per demo project, as (day offset from today, done). There is no staff milestone store in the demo, so these
 *  are the fixture's own; offsets keep it from rotting into "everything is late". */
const DEMO_MILESTONES: Record<string, Array<{ id: string; name: string; offset: number; done: boolean }>> = {
  "p-web-1": [
    { id: "dm-1", name: "Discovery complete", offset: -30, done: true },
    { id: "dm-2", name: "Design approved", offset: -8, done: true },
    { id: "dm-3", name: "Build and content load", offset: 9, done: false },
    { id: "dm-4", name: "Content sign-off", offset: -3, done: false },
  ],
  "p-web-2": [{ id: "dm-5", name: "Prototype review", offset: 20, done: false }],
  "p-seo-1": [{ id: "dm-6", name: "Audit delivered", offset: 5, done: false }],
};

const SETTLED = ["delivered", "approved", "done"];
const FINISHED = ["completed", "complete", "done", "archived", "cancelled"];

function aged(items: Array<{ since: string | null }>): { count: number; oldestSince: string | null } {
  const dated = items.map((i) => i.since).filter((s): s is string => !!s).sort();
  return { count: items.length, oldestSince: dated[0] ?? null };
}
const dueAged = (dates: string[]): DueAged => ({ count: dates.length, oldestDue: [...dates].sort()[0] ?? null });

type PartSpec = [TurnaroundKind, number | null, number, boolean];
function side(pooled: [number | null, number], parts: PartSpec[]): Turnaround {
  const mk = (kind: TurnaroundKind, medianDays: number | null, n: number, clientVisible: boolean): TurnaroundPart =>
    ({ kind, medianDays: n < 3 ? null : medianDays, n, withheld: n < 3, clientVisible });
  return { medianDays: pooled[1] < 3 ? null : pooled[0], n: pooled[1], withheld: pooled[1] < 3, parts: parts.map((p) => mk(...p)) };
}

/** Reply times per demo client. cl-3's read "failed" (`null`, with `turnaround` in `unavailable[]`), so the card's failed
 *  state is drivable in the browser; cl-2 has too few samples on the client's side, so "Not enough yet" is too. */
function demoTurnaround(clientId: string): ClientHealthDetail["turnaround"] {
  if (clientId === "cl-3") return null;
  const ours = side([1, 17], [["change_request_triage", 1, 6, true], ["payment_confirmed", 2.5, 3, false], ["conversation_reply", 0.5, 8, true]]);
  if (clientId === "cl-2") {
    return { windowDays: 90, client: side([0, 2], [["client_gate", 0, 2, true], ["contract_signed", 0, 0, true], ["post_review", 0, 0, true]]), ours };
  }
  if (clientId === "cl-4") {
    return { windowDays: 90, client: side([0, 0], [["client_gate", 0, 0, true], ["contract_signed", 0, 0, true], ["post_review", 0, 0, true]]), ours: side([0, 0], [["change_request_triage", 0, 0, true], ["payment_confirmed", 0, 0, true], ["conversation_reply", 0, 0, true]]) };
  }
  return { windowDays: 90, client: side([2, 11], [["client_gate", 2, 4, true], ["contract_signed", 3, 2, true], ["post_review", 1.5, 5, true]]), ours };
}

export function buildDemoClientHealth(i: DemoHealthInput): ClientHealthDetail {
  const { now } = i;
  const today = ymd(now);
  const unavailable: HealthSource[] = i.clientId === "cl-3" ? ["turnaround"] : [];

  const projects: ProjectHealth[] = i.projects.map((p) => {
    const ms = DEMO_MILESTONES[p.id] ?? [];
    const open = ms.filter((m) => !m.done);
    const upcoming = open.filter((m) => offsetDay(now, m.offset) >= today);
    const next = [...upcoming].sort((a, b) => a.offset - b.offset)[0];
    const dl = i.deliverables.filter((d) => d.projectId === p.id);
    return {
      projectId: p.id, name: p.name, status: p.status, clientVisible: true,
      milestones: { total: ms.length, done: ms.length - open.length, upcoming: upcoming.length, late: open.length - upcoming.length, undated: 0 },
      deliverables: {
        total: dl.length,
        delivered: dl.filter((d) => SETTLED.includes(d.status)).length,
        late: dl.filter((d) => d.dueDate && d.dueDate < today && !SETTLED.includes(d.status)).length,
      },
      nextMilestone: next ? { id: next.id, name: next.name, dueDate: offsetDay(now, next.offset) } : null,
    };
  });

  const active = i.projects.filter((p) => !FINISHED.includes(p.status));
  const activeIds = new Set(active.map((p) => p.id));
  const lateDeliverableDates = i.deliverables
    .filter((d) => activeIds.has(d.projectId) && d.dueDate && d.dueDate < today && !SETTLED.includes(d.status))
    .map((d) => d.dueDate as string);
  const lateDeliverables = dueAged(lateDeliverableDates);
  const lateMilestoneDates = active.flatMap((p) =>
    (DEMO_MILESTONES[p.id] ?? []).filter((m) => !m.done && offsetDay(now, m.offset) < today).map((m) => offsetDay(now, m.offset)));
  const lateMilestones = dueAged(lateMilestoneDates);
  const overdueInvoices = dueAged(i.invoices.filter((v) => v.status === "sent" && v.dueDate && v.dueDate < today).map((v) => v.dueDate as string));
  const waitingOnUs = aged(i.needsUs);
  const waitingOnClient = aged(i.needsClient);

  const v = evaluateClientHealth(
    {
      waitingOnUs, waitingOnClient, lateDeliverables, lateMilestones, overdueInvoices,
      site: null, activeProjects: active.length, activeServices: 0,
    },
    unavailable,
    now,
  );

  return {
    clientId: i.clientId, name: i.name, status: i.status,
    ownerUserId: null, ownerName: null,
    state: v.state, reasons: v.reasons,
    signals: {
      waitingOnUs, waitingOnClient, lateDeliverables, lateMilestones,
      openChangeRequests: null, conversationsAwaitingReply: i.conversationsAwaitingReply,
      overdueInvoices, site: null, deliveryOnTime: null,
      activeProjects: active.length, activeServices: 0,
    },
    asOf: now.toISOString(),
    onTimeKnownSince: "2026-10-15T09:00:00.000Z",
    unavailable,
    projects,
    turnaround: demoTurnaround(i.clientId),
  };
}
