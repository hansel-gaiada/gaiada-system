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
export const listDevices = (u: string, t: string) =>
  skipUnavailable(platformFetch<Device[]>(`/api/${t}/it/devices`, u), [] as Device[]);

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
