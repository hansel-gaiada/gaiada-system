import "server-only";
// MON — DEMO_MODE fixtures for the monitoring board (`/monitoring`, `/monitoring/[id]`), the alert
// channel/route manager (`/monitoring/channels`) and maintenance windows (`/monitoring/maintenance`).
// Mirrors demoWebdevProvisionedSites.ts's convention. Wired from demoFixtures.getDemoResponse,
// BEFORE the generic route matching.
//
// ── MON-20 — CHANNELS/ROUTES/MAINTENANCE ARE NOW WRITABLE, SO THEY LIVE IN globalThis ───────────
// Monitors/incidents/results/kinds stay read-only module consts (nothing here writes them yet), but
// channels, routes and maintenance windows are mutated by monitoringActions.ts's `"use server"`
// action graph, which Next bundles SEPARATELY from the page's RSC read graph. A plain module-level
// array would give each graph its own instance — a create/edit/delete POST would mutate one copy
// while the page's next GET reads the other, so the page would never show the result of a write that
// just "succeeded". `demoWebdevProvisionedSites.ts`'s `STORE_KEY` is the worked example this follows.
//
// ── THE FIXTURES ARE DELIBERATELY UNFLATTERING ─────────────────────────────────────────────────
// This module replaces Gaia Nexus, whose dashboard derived Lighthouse scores from a hash of the
// site name and therefore always looked healthy. A demo dataset of twelve green rows would repeat
// that mistake in a different medium — it would make the surface look finished and would exercise
// none of the states that matter. So the seed carries, on purpose: one hard DOWN with an open
// unacknowledged incident, one DEGRADED, one STALE monitor (last check far older than three
// intervals, which the board must call out rather than keep rendering as up), one monitor in a
// maintenance window, one UNKNOWN that has never been checked at all, an expiring TLS certificate
// inside the 7-day critical band, and a domain inside the 30-day warn band. Every branch in
// page.tsx and [id]/page.tsx is reachable in a browser with no clicking.
//
// Times are computed relative to now() so the "checked 40s ago" / "stale" / "expires in 5d"
// rendering stays true whenever someone opens it, rather than decaying into a wall of "3y ago".

import type {
  Monitor,
  MonitorDetail,
  MonitorResult,
  Incident,
  MonitoringSummary,
  MonitorKindSpec,
  MonitorChannel,
  MonitorRoute,
  MonitorStatus,
  MaintenanceWindow,
} from "./monitoring";

type MaintenanceWindowRow = MaintenanceWindow;

export interface DemoResult {
  status: number;
  json: unknown;
}
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
// MON-20 fix — every other demo store (demoCheckins.ts, demoSocial.ts, demoGithubRepos.ts, …) keys
// the error body `{ error }`, because `platformFetch`'s DEMO_MODE branch reads `body?.error` when
// building the thrown `PlatformError` (lib/platform.ts). This file alone used `{ message }`, so
// every `err(...)` here was silently discarded in favour of the generic "platform <status>" fallback
// — harmless while nothing surfaced the message to a user, but MON-20's new write actions DO (a
// bad edit or a channel with no destination should show its real reason, not a bare status code).
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

const SEC = 1000;
const DAY = 86400 * SEC;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

function monitors(): Monitor[] {
  return [
    {
      id: "mon-viceroy-http",
      name: "viceroybali.com",
      kind: "http",
      status: "down",
      clientId: "cli-viceroy",
      clientName: "Viceroy Bali",
      target: "https://viceroybali.com",
      severity: "page",
      enabled: true,
      intervalSec: 60,
      lastCheckedAt: iso(-45 * SEC),
      lastLatencyMs: null,
      uptime24h: 0.9213,
      uptime30d: 0.9975,
      certExpiresAt: iso(112 * DAY),
      domainExpiresAt: iso(240 * DAY),
      openIncidentId: "inc-1",
      tags: ["wordpress", "earner"],
    },
    {
      // The failure mode a plain 200-check cannot see: the page is up and serving, but the
      // expected marker string is gone. This is what MON-06 (K2 body assertions) exists for.
      id: "mon-aperitif-keyword",
      name: "aperitif.com — booking widget",
      kind: "keyword",
      status: "degraded",
      clientId: "cli-aperitif",
      clientName: "Aperitif Restaurant & Bar",
      target: "https://aperitif.com/reservations",
      severity: "ticket",
      enabled: true,
      intervalSec: 300,
      lastCheckedAt: iso(-120 * SEC),
      lastLatencyMs: 2840,
      uptime24h: 0.9780,
      uptime30d: 0.9944,
      certExpiresAt: iso(5 * DAY), // inside the 7d CRITICAL band
      domainExpiresAt: iso(21 * DAY), // inside the 30d WARN band
      tags: ["wordpress"],
    },
    {
      // STALE: interval is 60s but the last check is ~2h old. The board must flag this rather than
      // continue to present "up" as though it were current.
      id: "mon-cascades-http",
      name: "cascadesbali.com",
      kind: "http",
      status: "up",
      clientId: "cli-cascades",
      clientName: "Cascades Bali",
      target: "https://cascadesbali.com",
      severity: "ticket",
      enabled: true,
      intervalSec: 60,
      lastCheckedAt: iso(-2 * 3600 * SEC),
      lastLatencyMs: 410,
      uptime24h: 0.9990,
      uptime30d: 0.9992,
      certExpiresAt: iso(64 * DAY),
      domainExpiresAt: iso(410 * DAY),
      tags: ["wordpress"],
    },
    {
      // The heartbeat monitor (K1/MON-13) — the class of failure that has bitten this estate twice
      // in production (n8n flows darkened; mcp-hub served zero tools for days), both silently.
      id: "mon-nightly-sweep",
      name: "Nightly GSC sweep (heartbeat)",
      kind: "heartbeat",
      status: "up",
      clientId: "cli-internal",
      clientName: "Gaia Digital Agency",
      target: null,
      severity: "page",
      enabled: true,
      intervalSec: 86400,
      lastCheckedAt: iso(-6 * 3600 * SEC),
      lastLatencyMs: null,
      uptime24h: 1,
      uptime30d: 0.9667,
      tags: ["internal", "scheduler"],
    },
    {
      id: "mon-blossom-tls",
      name: "blossomsteakhouse.com — TLS",
      kind: "tls",
      status: "maintenance",
      clientId: "cli-blossom",
      clientName: "Blossom Steakhouse",
      target: "blossomsteakhouse.com:443",
      severity: "ticket",
      enabled: true,
      intervalSec: 3600,
      lastCheckedAt: iso(-15 * 60 * SEC),
      lastLatencyMs: 88,
      uptime24h: 1,
      uptime30d: 0.9998,
      inMaintenanceUntil: iso(3 * 3600 * SEC),
      certExpiresAt: iso(29 * DAY),
      domainExpiresAt: iso(300 * DAY),
      tags: ["wordpress"],
    },
    {
      // Registered but never probed. `unknown` + a null lastCheckedAt must render as "never",
      // never as a green tile — this row is the guard against that regression.
      id: "mon-akoya-dns",
      name: "akoyaspabali.com — DNS A record",
      kind: "dns",
      status: "unknown",
      clientId: "cli-akoya",
      clientName: "Akoya Spa Bali",
      target: "akoyaspabali.com",
      severity: "info",
      enabled: false,
      intervalSec: 3600,
      lastCheckedAt: null,
      lastLatencyMs: null,
      uptime24h: null,
      uptime30d: null,
      tags: ["dns"],
    },
  ];
}

function incidents(): Incident[] {
  return [
    {
      id: "inc-1",
      monitorId: "mon-viceroy-http",
      monitorName: "viceroybali.com",
      clientName: "Viceroy Bali",
      openedAt: iso(-113 * 60 * SEC),
      cause: "connect: connection refused (origin 502 upstream)",
      severity: "page",
    },
    {
      id: "inc-2",
      monitorId: "mon-aperitif-keyword",
      monitorName: "aperitif.com — booking widget",
      clientName: "Aperitif Restaurant & Bar",
      openedAt: iso(-40 * 60 * SEC),
      cause: 'assertion failed: expected body to contain "Book a table"',
      severity: "ticket",
      acknowledgedAt: iso(-25 * 60 * SEC),
      acknowledgedBy: "Hansel",
    },
  ];
}

/**
 * Synthesise a check history. `downFrom`/`downTo` are indexes from the OLD end, so a caller can
 * place an outage inside the window and the uptime strip shows a contiguous run of failures rather
 * than random noise — which is what makes "when did it break, and for how long" legible.
 */
function history(
  count: number,
  intervalSec: number,
  status: MonitorStatus,
  outage?: { from: number; to: number },
): MonitorResult[] {
  const out: MonitorResult[] = [];
  for (let i = 0; i < count; i++) {
    const age = (count - 1 - i) * intervalSec * SEC;
    const inOutage = outage ? i >= outage.from && i <= outage.to : false;
    out.push({
      checkedAt: iso(-age),
      status: inOutage ? status : "up",
      latencyMs: inOutage ? null : 180 + ((i * 37) % 260),
      detail: inOutage ? "connect: connection refused" : null,
    });
  }
  return out;
}

const HISTORIES: Record<string, MonitorResult[]> = {
  "mon-viceroy-http": history(90, 60, "down", { from: 60, to: 89 }),
  "mon-aperitif-keyword": history(60, 300, "degraded", { from: 52, to: 59 }),
  "mon-cascades-http": history(90, 60, "up"),
  "mon-nightly-sweep": history(30, 86400, "up"),
  "mon-blossom-tls": history(24, 3600, "up"),
  "mon-akoya-dns": [],
};

function summary(): MonitoringSummary {
  const rows = monitors();
  const by = (s: MonitorStatus) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    up: by("up"),
    down: by("down"),
    degraded: by("degraded"),
    maintenance: by("maintenance"),
    unknown: by("unknown"),
    openIncidents: incidents().filter((i) => !i.closedAt).length,
    lastSweepAt: iso(-40 * SEC),
  };
}

/**
 * What the driver registry reports it can probe. `available:false` on mqtt/steam is the point of
 * this fixture: the UI must show a declared-but-unimplemented kind as UNAVAILABLE rather than
 * offering it and failing at save time — "absent, not silently inert" (monitoring-program.md §3.2).
 */
function kinds(): MonitorKindSpec[] {
  return [
    { kind: "http", label: "HTTP(S)", capabilities: ["status", "latency", "redirect"], available: true },
    { kind: "keyword", label: "HTTP + content assertion", capabilities: ["status", "body_contains", "body_absent", "json_path"], available: true },
    { kind: "tcp", label: "TCP port", capabilities: ["connect", "latency"], available: true },
    { kind: "dns", label: "DNS record", capabilities: ["record_equals", "record_changed"], available: true },
    { kind: "tls", label: "TLS certificate", capabilities: ["expiry", "chain"], available: true },
    { kind: "heartbeat", label: "Heartbeat / push", capabilities: ["grace_period"], available: true },
    { kind: "mqtt", label: "MQTT topic", capabilities: ["message_received"], available: false },
    { kind: "steam", label: "Steam game server", capabilities: ["query"], available: false },
  ];
}

/**
 * Channels + routes. Seeded to show the three quiet failure modes the page exists to surface,
 * because each one means "you believe you are covered and you are not":
 *   - `ch-webhook-n8n` is FAILING (4 consecutive failures) — the agentic path is dead,
 *   - `ch-email-ops` is enabled but has NO route pointing at it — configured, never used,
 *   - `rt-catchall` matches everything — the route that floods a channel and gets it muted.
 * A demo where all three are green would make the page look like decoration — the writable store
 * below only ADDS to this seed (create/edit/delete), it never resets it, so those three states stay
 * reachable across a session even after someone starts clicking around.
 */
const CHANNEL_STORE_KEY = Symbol.for("gaiada.demoMonitoring.channels");
const CHANNELS: MonitorChannel[] = ((globalThis as Record<symbol, unknown>)[CHANNEL_STORE_KEY] ??= [
  {
    id: "ch-telegram-ops",
    kind: "telegram",
    name: "Ops Telegram",
    enabled: true,
    destination: "@gaiada-alerts",
    lastDeliveryAt: iso(-18 * 60 * SEC),
    lastDeliveryOk: true,
    failureCount: 0,
  },
  {
    id: "ch-webhook-n8n",
    kind: "webhook",
    name: "n8n incident flow",
    enabled: true,
    // Redacted: the real config holds a secret REFERENCE, never the token itself.
    destination: "https://erp.gaiada.online/n8n/webhook/incident-…",
    lastDeliveryAt: iso(-9 * 60 * SEC),
    lastDeliveryOk: false,
    failureCount: 4,
  },
  {
    id: "ch-email-ops",
    kind: "email",
    name: "Ops mailbox",
    enabled: true,
    destination: "ops@gaiada.com",
    lastDeliveryAt: null,
    lastDeliveryOk: null,
    failureCount: 0,
  },
  {
    id: "ch-mcp-hermes",
    kind: "mcp",
    name: "Hermes (agent triage)",
    enabled: true,
    destination: "mcp-hub → monitoring.incident.*",
    lastDeliveryAt: iso(-9 * 60 * SEC),
    lastDeliveryOk: true,
    failureCount: 0,
  },
]) as MonitorChannel[];

const ROUTE_STORE_KEY = Symbol.for("gaiada.demoMonitoring.routes");
const ROUTES: MonitorRoute[] = ((globalThis as Record<symbol, unknown>)[ROUTE_STORE_KEY] ??= [
  {
    id: "rt-page",
    channelId: "ch-telegram-ops",
    channelName: "Ops Telegram",
    matchSeverity: "page",
    enabled: true,
  },
  {
    id: "rt-agent",
    channelId: "ch-mcp-hermes",
    channelName: "Hermes (agent triage)",
    matchSeverity: "ticket",
    enabled: true,
  },
  {
    id: "rt-catchall",
    channelId: "ch-webhook-n8n",
    channelName: "n8n incident flow",
    enabled: true,
  },
]) as MonitorRoute[];

const MAINTENANCE_STORE_KEY = Symbol.for("gaiada.demoMonitoring.maintenance");
const MAINTENANCE: MaintenanceWindowRow[] = ((globalThis as Record<symbol, unknown>)[MAINTENANCE_STORE_KEY] ??= [
  {
    id: "mw-1",
    scope: "monitor:mon-blossom-tls",
    startsAt: iso(-1 * 3600 * SEC),
    endsAt: iso(3 * 3600 * SEC),
    reason: "WordPress + PHP 8.3 upgrade",
    createdBy: "Hansel",
  },
]) as MaintenanceWindowRow[];

let seq = 100;
const nid = (prefix: string) => `${prefix}-demo-${++seq}`;

function channelName(id: string): string | null {
  return CHANNELS.find((c) => c.id === id)?.name ?? null;
}

export function monitoringDemo(
  method: string,
  p: string,
  params: URLSearchParams,
  body: string | undefined,
): DemoResult | null {
  const m = method.toUpperCase();

  // ── channels ──────────────────────────────────────────────────────────────────────────────────
  if (p.match(/^\/api\/[^/]+\/monitoring\/channels$/) && m === "GET") return ok(CHANNELS);
  if (p.match(/^\/api\/[^/]+\/monitoring\/channels$/) && m === "POST") {
    const b = JSON.parse(body || "{}") as { kind?: string; name?: string; destination?: string; enabled?: boolean };
    if (!b.name?.trim()) return err(400, "name is required");
    if (!b.kind?.trim()) return err(400, "kind is required");
    if (!b.destination?.trim()) return err(400, "destination is required");
    const row: MonitorChannel = {
      id: nid("ch"),
      kind: b.kind.trim(),
      name: b.name.trim(),
      enabled: b.enabled !== false,
      destination: b.destination.trim(),
      lastDeliveryAt: null,
      lastDeliveryOk: null,
      failureCount: 0,
    };
    CHANNELS.push(row);
    return ok({ id: row.id }, 201);
  }
  const channelM = p.match(/^\/api\/[^/]+\/monitoring\/channels\/([^/]+)$/);
  if (channelM && m === "PATCH") {
    const row = CHANNELS.find((c) => c.id === channelM[1]);
    if (!row) return err(404, "channel not found");
    const b = JSON.parse(body || "{}") as Partial<{ kind: string; name: string; destination: string; enabled: boolean }>;
    if (b.kind !== undefined) row.kind = b.kind;
    if (b.name !== undefined) row.name = b.name;
    if (b.destination !== undefined) row.destination = b.destination;
    if (b.enabled !== undefined) row.enabled = b.enabled;
    return ok({ id: row.id });
  }
  if (channelM && m === "DELETE") {
    const i = CHANNELS.findIndex((c) => c.id === channelM[1]);
    if (i === -1) return err(404, "channel not found");
    CHANNELS.splice(i, 1);
    // A channel's routes are now dangling — drop them too, mirroring an ON DELETE CASCADE. Leaving
    // them behind would make a route reference a channel that no longer exists, which is a worse
    // demo state than the real "unrouted channel" warning this page already models.
    for (let ri = ROUTES.length - 1; ri >= 0; ri--) {
      if (ROUTES[ri].channelId === channelM[1]) ROUTES.splice(ri, 1);
    }
    return ok({});
  }
  const testM = p.match(/^\/api\/[^/]+\/monitoring\/channels\/([^/]+)\/test$/);
  if (testM && m === "POST") {
    const row = CHANNELS.find((c) => c.id === testM[1]);
    if (!row) return err(404, "channel not found");
    if (!row.destination) return err(422, "This channel has no destination configured yet.");
    // Mirrors the real outcome: a send updates the channel's own delivery health, so the page's
    // "failing"/"degraded" badges move in response to the test rather than staying frozen.
    row.lastDeliveryAt = iso(0);
    row.lastDeliveryOk = true;
    row.failureCount = 0;
    return ok({ ok: true });
  }

  // ── routes ────────────────────────────────────────────────────────────────────────────────────
  if (p.match(/^\/api\/[^/]+\/monitoring\/routes$/) && m === "GET") {
    return ok(ROUTES.map((r) => ({ ...r, channelName: channelName(r.channelId) ?? r.channelName })));
  }
  if (p.match(/^\/api\/[^/]+\/monitoring\/routes$/) && m === "POST") {
    const b = JSON.parse(body || "{}") as {
      channelId?: string; matchClientId?: string | null; matchSeverity?: string | null; matchKind?: string | null; enabled?: boolean;
    };
    if (!b.channelId?.trim()) return err(400, "channelId is required");
    if (!CHANNELS.some((c) => c.id === b.channelId)) return err(400, "channel not found");
    const row: MonitorRoute = {
      id: nid("rt"),
      channelId: b.channelId.trim(),
      channelName: channelName(b.channelId.trim()),
      matchClientId: b.matchClientId || null,
      matchSeverity: (b.matchSeverity as MonitorRoute["matchSeverity"]) || null,
      matchKind: b.matchKind || null,
      enabled: b.enabled !== false,
    };
    ROUTES.push(row);
    return ok({ id: row.id }, 201);
  }
  const routeM = p.match(/^\/api\/[^/]+\/monitoring\/routes\/([^/]+)$/);
  if (routeM && m === "PATCH") {
    const row = ROUTES.find((r) => r.id === routeM[1]);
    if (!row) return err(404, "route not found");
    const b = JSON.parse(body || "{}") as Partial<{
      channelId: string; matchClientId: string | null; matchSeverity: string | null; matchKind: string | null; enabled: boolean;
    }>;
    if (b.channelId !== undefined) {
      if (!CHANNELS.some((c) => c.id === b.channelId)) return err(400, "channel not found");
      row.channelId = b.channelId;
      row.channelName = channelName(b.channelId);
    }
    if (b.matchClientId !== undefined) row.matchClientId = b.matchClientId;
    if (b.matchSeverity !== undefined) row.matchSeverity = b.matchSeverity as MonitorRoute["matchSeverity"];
    if (b.matchKind !== undefined) row.matchKind = b.matchKind;
    if (b.enabled !== undefined) row.enabled = b.enabled;
    return ok({ id: row.id });
  }
  if (routeM && m === "DELETE") {
    const i = ROUTES.findIndex((r) => r.id === routeM[1]);
    if (i === -1) return err(404, "route not found");
    ROUTES.splice(i, 1);
    return ok({});
  }

  // ── maintenance ───────────────────────────────────────────────────────────────────────────────
  if (p.match(/^\/api\/[^/]+\/monitoring\/maintenance$/) && m === "GET") return ok(MAINTENANCE);
  if (p.match(/^\/api\/[^/]+\/monitoring\/maintenance$/) && m === "POST") {
    const b = JSON.parse(body || "{}") as { scope?: string; startsAt?: string; endsAt?: string; reason?: string | null };
    if (!b.startsAt || !b.endsAt) return err(400, "startsAt and endsAt are required");
    const row: MaintenanceWindowRow = {
      id: nid("mw"),
      scope: b.scope?.trim() || "all",
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      reason: b.reason ?? null,
      createdBy: "Hansel",
    };
    MAINTENANCE.push(row);
    return ok({ id: row.id }, 201);
  }
  const maintenanceM = p.match(/^\/api\/[^/]+\/monitoring\/maintenance\/([^/]+)$/);
  if (maintenanceM && m === "DELETE") {
    const i = MAINTENANCE.findIndex((w) => w.id === maintenanceM[1]);
    if (i === -1) return err(404, "maintenance window not found");
    MAINTENANCE.splice(i, 1);
    return ok({});
  }

  if (p.match(/^\/api\/[^/]+\/monitoring\/monitors$/) && m === "POST") {
    return ok({ id: "mon-demo-created" });
  }
  if (p.match(/^\/api\/[^/]+\/monitoring\/incidents\/[^/]+\/ack$/) && m === "POST") {
    return ok({ id: "inc-acked" });
  }

  if (p.match(/^\/api\/[^/]+\/monitoring\/summary$/) && m === "GET") return ok(summary());
  if (p.match(/^\/api\/[^/]+\/monitoring\/kinds$/) && m === "GET") return ok(kinds());

  if (p.match(/^\/api\/[^/]+\/monitoring\/incidents$/) && m === "GET") {
    const limit = Number(params.get("limit") ?? "25");
    const status = params.get("status");
    let rows = incidents();
    if (status === "open") rows = rows.filter((i) => !i.closedAt);
    return ok(rows.slice(0, Number.isFinite(limit) ? limit : 25));
  }

  const resultsM = p.match(/^\/api\/[^/]+\/monitoring\/monitors\/([^/]+)\/results$/);
  if (resultsM && m === "GET") {
    const all = HISTORIES[resultsM[1]] ?? [];
    // MON-20 — actually honour `window`, so the 24h/7d/30d switcher on `[id]/page.tsx` has something
    // to switch BETWEEN in DEMO_MODE. Without this every window would render the identical dataset
    // and the control would look wired but do nothing under demo verification.
    const win = params.get("window");
    const windowMs = win === "30d" ? 30 * DAY : win === "7d" ? 7 * DAY : DAY;
    const cutoff = Date.now() - windowMs;
    return ok(all.filter((r) => Date.parse(r.checkedAt) >= cutoff));
  }

  const detailM = p.match(/^\/api\/[^/]+\/monitoring\/monitors\/([^/]+)$/);
  if (detailM && m === "GET") {
    const base = monitors().find((x) => x.id === detailM[1]);
    if (!base) return err(404, "monitor not found");
    const detail: MonitorDetail = {
      ...base,
      results: HISTORIES[base.id] ?? [],
      incidents: incidents().filter((i) => i.monitorId === base.id),
      // Redacted server-side in the real backend. Secret REFERENCES only, never secrets —
      // a webhook URL with an embedded token is a credential (monitoring-program.md §3.4).
      config: { method: "GET", expectStatus: 200, followRedirects: true },
      createdAt: iso(-90 * DAY),
      createdBy: "Hansel",
    };
    return ok(detail);
  }

  if (p.match(/^\/api\/[^/]+\/monitoring\/monitors$/) && m === "GET") {
    let rows = monitors();
    const clientId = params.get("clientId");
    const kind = params.get("kind");
    const status = params.get("status");
    if (clientId) rows = rows.filter((r) => r.clientId === clientId);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (status) rows = rows.filter((r) => r.status === status);
    return ok(rows);
  }

  return null;
}
