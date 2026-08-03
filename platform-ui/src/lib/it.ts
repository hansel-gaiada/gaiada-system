import "server-only";
// IT department data layer — physical + connected device registry, heartbeat/
// status monitoring, and the n8n workflow definitions behind the embedded
// canvas viewer. The backend IT/device API does not exist yet; every reader
// DEGRADES gracefully (null/[] on 404/403) so pages ship ahead of the backend
// and show an empty/"not connected" state instead of crashing — same pattern as
// lib/admin.ts and lib/entities.ts.
//
// BFF CONTRACT (implement in platform-nest to match — see memory
// [[it-device-contract]]):
//   GET  /api/:t/it/devices                 -> Device[]
//   POST /api/:t/it/devices        body {..} -> { id }        (elevated / IT role)
//   GET  /api/:t/it/devices/:id             -> DeviceDetail | 404
//   GET  /api/:t/it/events?deviceId&limit   -> DeviceEvent[]
//   GET  /api/admin/automation/workflows        -> WorkflowSummary[]
//   GET  /api/admin/automation/workflows/:id    -> N8nWorkflow (nodes+connections)
// Devices readable by any member of :t; register/edit is elevated/IT-role only
// (RLS/Cerbos is the real boundary; the UI also gates).
import { platformFetch, PlatformError } from "./platform";

export type DeviceKind =
  | "cctv" | "printer" | "server" | "workstation" | "network" | "sensor" | "iot" | "other";
export const DEVICE_KINDS: DeviceKind[] =
  ["cctv", "printer", "server", "workstation", "network", "sensor", "iot", "other"];

export type DeviceStatus = "online" | "offline" | "degraded" | "unknown";
export const DEVICE_STATUSES: DeviceStatus[] = ["online", "offline", "degraded", "unknown"];

export type DeviceClass = "infrastructure" | "managed" | "byod";
export const DEVICE_CLASSES: DeviceClass[] = ["infrastructure", "managed", "byod"];
export type DiscoverySource = "manual" | "unifi";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  status: DeviceStatus;
  site?: string | null;
  network?: string | null;
  ip?: string | null;
  mac?: string | null;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  lastHeartbeatAt?: string | null;
  registeredAt?: string | null;
  uptimeSec?: number | null;
  labels?: string[];
  // IT-01 network-discovery fields. Absent on a backend that predates migration 0071, so every
  // consumer must treat them as optional rather than assuming a discovered estate.
  discoverySource?: DiscoverySource;
  deviceClass?: DeviceClass;
  hostname?: string | null;
  isWired?: boolean | null;
  ssid?: string | null;
  uplinkMac?: string | null;
  uplinkPort?: number | null;
  lastSeenAt?: string | null;
  firstSeenAt?: string | null;
}

// ---- Topology (IT-05, server-computed) ----
export interface DeviceLink {
  childDeviceId: string;
  parentDeviceId: string;
  port: number | null;
  medium: "wired" | "wireless" | "unknown";
}
export interface DiscoveryRun {
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean;
  devicesSeen: number;
  byodCount: number;
  error: string | null;
}
export interface TopologyResponse {
  devices: Device[];
  links: DeviceLink[];
  lastRun: DiscoveryRun | null;
}

export type DeviceEventType = "registered" | "online" | "offline" | "degraded" | "alert" | "heartbeat";
export type DeviceEventSeverity = "info" | "warn" | "critical";
export interface DeviceEvent {
  id: string;
  deviceId: string;
  deviceName?: string | null;
  type: DeviceEventType;
  severity: DeviceEventSeverity;
  message: string;
  occurred_at: string;
}

export interface DeviceDetail extends Device {
  events: DeviceEvent[];
  heartbeats: number[]; // recent reachability/latency series for the sparkline
}

// ---- n8n workflow shapes (the subset the canvas needs) ----
export interface WorkflowSummary { id: string; name: string; active: boolean; updatedAt?: string | null }
export interface N8nNode { id?: string; name: string; type: string; position: [number, number] }
export interface N8nConnectionTarget { node: string; type: string; index: number }
export interface N8nWorkflow {
  id: string;
  name: string;
  active?: boolean;
  nodes: N8nNode[];
  connections: Record<string, { main?: N8nConnectionTarget[][] }>;
}

// Mirrors lib/admin.ts / lib/entities.ts: absorb 404 (not found) and 403
// (feature/module not enabled) so callers get a graceful fallback either way.
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

// ---- Devices ----
export const listDevices = (u: string, t: string, q: { deviceClass?: string; q?: string } = {}) => {
  const qs = new URLSearchParams({
    ...(q.deviceClass ? { deviceClass: q.deviceClass } : {}),
    ...(q.q ? { q: q.q } : {}),
  }).toString();
  return skipUnavailable(
    platformFetch<Device[]>(`/api/${t}/it/devices${qs ? `?${qs}` : ""}`, u),
    [] as Device[],
  );
};

// Server-computed graph. Falls back to a devices-only shape so the page still renders (grouped, via
// buildTopology) against a backend that predates the endpoint.
export async function getTopology(u: string, t: string): Promise<TopologyResponse> {
  try {
    return await platformFetch<TopologyResponse>(`/api/${t}/it/topology`, u);
  } catch (e) {
    if (!(e instanceof PlatformError && (e.status === 404 || e.status === 403 || e.status === 405))) throw e;
    return { devices: await listDevices(u, t), links: [], lastRun: null };
  }
}

export async function getDevice(u: string, t: string, id: string): Promise<DeviceDetail | null> {
  try {
    return await platformFetch<DeviceDetail>(`/api/${t}/it/devices/${id}`, u);
  } catch (e) {
    if (!(e instanceof PlatformError && (e.status === 404 || e.status === 405))) throw e;
  }
  // Derive a minimal detail from the list so create→view never dead-ends.
  const list = await listDevices(u, t);
  const found = list.find((d) => d.id === id);
  if (!found) return null;
  return { ...found, events: [], heartbeats: [] };
}

export const listDeviceEvents = (u: string, t: string, q: { deviceId?: string; limit?: number } = {}) =>
  skipUnavailable(
    platformFetch<DeviceEvent[]>(
      `/api/${t}/it/events?${new URLSearchParams({
        ...(q.deviceId ? { deviceId: q.deviceId } : {}),
        ...(q.limit ? { limit: String(q.limit) } : {}),
      })}`,
      u,
    ),
    [] as DeviceEvent[],
  );

// ---- n8n workflows (behind the embedded canvas) ----
export const listWorkflows = (u: string) =>
  skipUnavailable(platformFetch<WorkflowSummary[]>(`/api/admin/automation/workflows`, u), [] as WorkflowSummary[]);

export const getWorkflow = (u: string, id: string) =>
  skipUnavailable(platformFetch<N8nWorkflow | null>(`/api/admin/automation/workflows/${id}`, u), null);

// ================= Pure helpers (unit-tested) =================

export interface HealthSummary { total: number; online: number; degraded: number; offline: number; unknown: number }
export function summarizeHealth(devices: Device[]): HealthSummary {
  const s: HealthSummary = { total: 0, online: 0, degraded: 0, offline: 0, unknown: 0 };
  for (const d of devices) {
    s.total += 1;
    s[d.status] += 1;
  }
  return s;
}

export interface TopologyNetwork { name: string; devices: Device[] }
export interface TopologySite { name: string; networks: TopologyNetwork[] }
// Group devices by site then network. Missing fields fall into "Unassigned"
// buckets so nothing is dropped. Stable alphabetical ordering with "Unassigned"
// pushed last.
export function buildTopology(devices: Device[]): TopologySite[] {
  const UNSET = "Unassigned";
  const sites = new Map<string, Map<string, Device[]>>();
  for (const d of devices) {
    const site = d.site?.trim() || UNSET;
    const net = d.network?.trim() || UNSET;
    if (!sites.has(site)) sites.set(site, new Map());
    const nets = sites.get(site)!;
    if (!nets.has(net)) nets.set(net, []);
    nets.get(net)!.push(d);
  }
  const sortNames = (a: string, b: string) =>
    (a === UNSET ? 1 : 0) - (b === UNSET ? 1 : 0) || a.localeCompare(b);
  return [...sites.entries()]
    .sort(([a], [b]) => sortNames(a, b))
    .map(([name, nets]) => ({
      name,
      networks: [...nets.entries()]
        .sort(([a], [b]) => sortNames(a, b))
        .map(([netName, devs]) => ({
          name: netName,
          devices: devs.slice().sort((x, y) => x.name.localeCompare(y.name)),
        })),
    }));
}

// ---- Real topology graph (IT-06) ----
export interface TopoNode {
  device: Device;
  medium: DeviceLink["medium"] | null;
  port: number | null;
  children: TopoNode[];
}
export interface TopoGraph {
  roots: TopoNode[];
  /** Devices with no uplink edge in either direction — normal on a first poll, and the home of
   *  every hand-registered device (nothing reports an uplink for those). Shown in its own bucket
   *  rather than silently omitted, so the map never hides part of the estate. */
  unlinked: Device[];
}

/**
 * Turn the flat (devices, links) pair into a forest. Replaces the old client-side buildTopology()
 * regroup, which could only bucket rows by two free-text strings and had no way to express an
 * uplink at all.
 *
 * Defensive against a link set that doesn't describe a clean tree: a child whose parent is missing
 * from `devices` is treated as a root, and a cycle is broken rather than recursed into (each child
 * has at most one parent by DB constraint, so only a ring could do it — but a ring would hang the
 * render, so it is guarded explicitly).
 */
export function buildGraph(devices: Device[], links: DeviceLink[]): TopoGraph {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const parentOf = new Map<string, DeviceLink>();
  const childrenOf = new Map<string, DeviceLink[]>();
  for (const l of links) {
    if (!byId.has(l.childDeviceId) || !byId.has(l.parentDeviceId)) continue;
    parentOf.set(l.childDeviceId, l);
    const arr = childrenOf.get(l.parentDeviceId) ?? [];
    arr.push(l);
    childrenOf.set(l.parentDeviceId, arr);
  }

  const inGraph = new Set<string>();
  for (const l of links) {
    if (byId.has(l.childDeviceId) && byId.has(l.parentDeviceId)) {
      inGraph.add(l.childDeviceId);
      inGraph.add(l.parentDeviceId);
    }
  }

  const build = (id: string, medium: DeviceLink["medium"] | null, port: number | null, seen: Set<string>): TopoNode => {
    const kids = (childrenOf.get(id) ?? [])
      .filter((l) => !seen.has(l.childDeviceId))
      .sort((a, b) => (byId.get(a.childDeviceId)!.name).localeCompare(byId.get(b.childDeviceId)!.name));
    const next = new Set(seen).add(id);
    return {
      device: byId.get(id)!,
      medium,
      port,
      children: kids.map((l) => build(l.childDeviceId, l.medium, l.port, next)),
    };
  };

  const roots = devices
    .filter((d) => inGraph.has(d.id) && !parentOf.has(d.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => build(d.id, null, null, new Set<string>()));

  const unlinked = devices
    .filter((d) => !inGraph.has(d.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { roots, unlinked };
}

/** Total devices in a forest — used to prove the graph accounts for every row it was given. */
export function countNodes(nodes: TopoNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

/**
 * Is the discovery feed stale? THE POINT: without this, a dead collector and an empty network render
 * identically, and an operator reads silence as "all clear". No run at all is stale by definition.
 */
export function isDiscoveryStale(
  run: DiscoveryRun | null,
  now: Date = new Date(),
  thresholdMs = 15 * 60 * 1000,
): boolean {
  if (!run) return true;
  if (!run.ok) return true;
  const stamp = run.finishedAt ?? run.startedAt;
  if (!stamp) return true;
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > thresholdMs;
}

/** "4 min ago" / "just now" / "never" — plain relative wording for the sync indicator. */
export function describeLastSync(run: DiscoveryRun | null, now: Date = new Date()): string {
  const stamp = run?.finishedAt ?? run?.startedAt;
  if (!stamp) return "never";
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.floor(Math.max(0, now.getTime() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export interface GraphNode { name: string; type: string; x: number; y: number }
export interface GraphEdge { from: string; to: string }
export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
// Normalize an n8n workflow into positioned nodes + resolved edges + bounds.
// n8n stores absolute node positions ([x,y]) and a connections map keyed by
// SOURCE node name -> main[outputIndex][] -> { node: targetName }. Kept pure so
// the client canvas can import a local copy without pulling this server module.
export function layoutGraph(wf: N8nWorkflow | null): GraphLayout {
  const nodes: GraphNode[] = (wf?.nodes ?? []).map((n) => ({
    name: n.name,
    type: shortType(n.type),
    x: n.position?.[0] ?? 0,
    y: n.position?.[1] ?? 0,
  }));
  const present = new Set(nodes.map((n) => n.name));
  const edges: GraphEdge[] = [];
  for (const [src, conn] of Object.entries(wf?.connections ?? {})) {
    for (const outputs of conn.main ?? []) {
      for (const target of outputs ?? []) {
        if (present.has(src) && present.has(target.node)) edges.push({ from: src, to: target.node });
      }
    }
  }
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const bounds = {
    minX: xs.length ? Math.min(...xs) : 0,
    minY: ys.length ? Math.min(...ys) : 0,
    maxX: xs.length ? Math.max(...xs) : 0,
    maxY: ys.length ? Math.max(...ys) : 0,
  };
  return { nodes, edges, bounds };
}

// "n8n-nodes-base.httpRequest" -> "httpRequest"; "@scope/pkg.Foo" -> "Foo".
export function shortType(type: string): string {
  const tail = type.split(".").pop() ?? type;
  return tail || type;
}
