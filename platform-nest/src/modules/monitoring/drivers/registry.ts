// MON-11a — the monitor driver registry. PURE: no I/O, no network, no DB.
//
// Design: docs/blueprints/monitoring-program.md §3.2.
//
// ── WHY A REGISTRY AND NOT A SWITCH ─────────────────────────────────────────────────────────────
// MQTT and Steam are named future wants and DNS matters now, so the set of kinds must be data plus a
// driver, never a hardcoded switch. This mirrors two patterns already proven in this codebase:
// `SearchDataProvider` (search) and `provision-provider.ts` (webdev). The UI reads the registry too
// (`GET /monitoring/kinds`), so registering a driver server-side makes it appear in the kind picker
// with NO frontend change.
//
// ── THREE RULES CARRIED FROM THE SEARCH PROGRAMME, EACH LEARNED THE HARD WAY ─────────────────────
// 1. ABSENT, NOT SILENTLY INERT. A kind with no registered driver must refuse loudly. The search
//    module's equivalent lesson was the unset unit rate: a $0 price did not disable a provider, it
//    disarmed every budget tier while looking configured. Here the failure would be worse — a monitor
//    whose driver is missing would sit in the board reporting `unknown` forever, which reads as "not
//    checked yet" rather than "can never be checked".
// 2. NO DEFAULT BRANCH in `parseKind`. It returns `MonitorKind | null` and callers must handle null
//    explicitly. This is SM-61's cadence lesson verbatim: two callers had each silently invented a
//    different convenient default, so "absent" meant one thing in one place and another elsewhere.
// 3. A REGISTRATION PIN. `registry.test.ts` asserts the registry's contents BY NAME, because a
//    correct-but-unwired driver is indistinguishable from an absent one — a pattern that has now
//    bitten this estate six times (most recently 14 of 18 `search.*` MCP tools shipping without a
//    pathTemplate and being silently uncallable).

/** Kinds this module knows how to *describe*. Whether one can RUN depends on registration. */
export type MonitorKind =
  | "http"
  | "keyword"
  | "tcp"
  | "dns"
  | "tls"
  | "heartbeat"
  // v2, drop-in: each needs only a driver file, no core change.
  | "mqtt"
  | "grpc"
  | "snmp"
  | "steam"
  | "docker"
  | "database";

const ALL_KINDS: readonly MonitorKind[] = [
  "http", "keyword", "tcp", "dns", "tls", "heartbeat",
  "mqtt", "grpc", "snmp", "steam", "docker", "database",
] as const;

/**
 * What a driver can evaluate. The API validates a monitor's assertions against its kind's
 * capabilities and REFUSES an assertion the kind cannot check — a silently-ignored assertion would
 * make a monitor report "up" for a condition it never actually evaluated, which is the single most
 * dangerous shape of bug in a monitoring system.
 */
export type MonitorCapability =
  | "status"
  | "latency"
  | "redirect"
  | "body_contains"
  | "body_absent"
  | "json_path"
  | "connect"
  | "record_equals"
  | "record_changed"
  | "expiry"
  | "chain"
  | "grace_period"
  | "message_received"
  | "query";

export type MonitorStatus = "up" | "down" | "degraded" | "maintenance" | "unknown";

export interface ProbeResult {
  status: MonitorStatus;
  latencyMs: number | null;
  /** Why it failed, from the driver. NOT public-safe: may quote an assertion string. */
  detail: string | null;
}

export interface ProbeCtx {
  /**
   * Resolved at dispatch from the tenant's VERIFIED `search_properties` (or the monitor's own target
   * after the same verification). A driver receives an allowlist, never a raw hostname to trust.
   */
  allowlistHosts: string[];
  timeoutMs: number;
  /** Every dial attempt, allowed or refused, is reported here — the guard's audit channel. */
  audit: (event: { host: string; allowed: boolean; reason: string }) => void;
}

export interface MonitorDriver<C = unknown> {
  kind: MonitorKind;
  capabilities: readonly MonitorCapability[];
  /**
   * Parse-don't-validate: returns the typed config or THROWS. A driver must never accept a config it
   * cannot fully interpret, because the alternative is probing something other than what the operator
   * described.
   */
  validate(config: unknown): C;
  probe(config: C, ctx: ProbeCtx): Promise<ProbeResult>;
}

/**
 * Declared shape of a kind for the UI, independent of whether a driver is registered.
 * `available: false` is deliberately RETURNED rather than the kind being omitted: hiding it makes
 * "not built yet" indistinguishable from "never designed", and a hidden-but-accepted kind would let
 * someone create a monitor that can never run.
 */
export interface MonitorKindSpec {
  kind: MonitorKind;
  label: string;
  capabilities: readonly MonitorCapability[];
  available: boolean;
}

/** Human labels + the capability contract each kind promises once implemented. */
const KIND_DECL: Record<MonitorKind, { label: string; capabilities: readonly MonitorCapability[] }> = {
  http: { label: "HTTP(S)", capabilities: ["status", "latency", "redirect"] },
  keyword: { label: "HTTP + content assertion", capabilities: ["status", "latency", "body_contains", "body_absent", "json_path"] },
  tcp: { label: "TCP port", capabilities: ["connect", "latency"] },
  dns: { label: "DNS record", capabilities: ["record_equals", "record_changed"] },
  tls: { label: "TLS certificate", capabilities: ["expiry", "chain"] },
  heartbeat: { label: "Heartbeat / push", capabilities: ["grace_period"] },
  mqtt: { label: "MQTT topic", capabilities: ["message_received"] },
  grpc: { label: "gRPC health", capabilities: ["connect", "latency"] },
  snmp: { label: "SNMP OID", capabilities: ["query"] },
  steam: { label: "Steam game server", capabilities: ["query"] },
  docker: { label: "Docker container", capabilities: ["status"] },
  database: { label: "Database connection", capabilities: ["connect", "query"] },
};

const drivers = new Map<MonitorKind, MonitorDriver<never>>();

/** Thrown when a monitor names a kind that has no registered driver. Mapped to HTTP by a filter. */
export class MonitorDriverUnavailableError extends Error {
  constructor(readonly kind: string) {
    super(
      `No monitor driver is registered for kind '${kind}'. The monitor cannot run. ` +
        `This is a deployment gap, not a transient failure — nothing will retry it.`,
    );
    this.name = "MonitorDriverUnavailableError";
  }
}

export function registerDriver<C>(driver: MonitorDriver<C>): void {
  if (!ALL_KINDS.includes(driver.kind)) {
    throw new Error(`monitor driver declares unknown kind '${driver.kind}'`);
  }
  if (drivers.has(driver.kind)) {
    throw new Error(`monitor driver for '${driver.kind}' already registered`);
  }
  // A driver whose declared capabilities exceed the kind's contract would let the API accept
  // assertions the rest of the system does not expect this kind to evaluate.
  const declared = new Set(KIND_DECL[driver.kind].capabilities);
  const extra = driver.capabilities.filter((c) => !declared.has(c));
  if (extra.length) {
    throw new Error(`driver '${driver.kind}' declares capabilities outside its kind contract: ${extra.join(", ")}`);
  }
  drivers.set(driver.kind, driver as unknown as MonitorDriver<never>);
}

/** Test-only, mirroring `resetModules()` in the module registry. */
export function resetDrivers(): void {
  drivers.clear();
}

/**
 * THROWS when absent. Deliberately not `undefined`: an Optional invites `if (driver) probe()`, which
 * silently skips the check and leaves the monitor looking un-probed rather than un-runnable.
 */
export function getDriver(kind: MonitorKind): MonitorDriver<never> {
  const d = drivers.get(kind);
  if (!d) throw new MonitorDriverUnavailableError(kind);
  return d;
}

export function hasDriver(kind: MonitorKind): boolean {
  return drivers.has(kind);
}

/**
 * `MonitorKind | null` with NO default branch — the SM-61 pattern. A caller must decide what an
 * unrecognised kind means; it must never inherit a convenient default from here.
 */
export function parseKind(value: unknown): MonitorKind | null {
  if (typeof value !== "string") return null;
  return (ALL_KINDS as readonly string[]).includes(value) ? (value as MonitorKind) : null;
}

/** Drives `GET /monitoring/kinds` and therefore the UI's kind picker. Every kind, with availability. */
export function listKindSpecs(): MonitorKindSpec[] {
  return ALL_KINDS.map((kind) => ({
    kind,
    label: KIND_DECL[kind].label,
    capabilities: KIND_DECL[kind].capabilities,
    available: drivers.has(kind),
  }));
}

/**
 * True when `kind` can evaluate `capability`. The API gates assertion creation on this so an
 * assertion is never stored against a kind that would ignore it.
 */
export function kindSupports(kind: MonitorKind, capability: MonitorCapability): boolean {
  return KIND_DECL[kind].capabilities.includes(capability);
}

export const KNOWN_KINDS = ALL_KINDS;
