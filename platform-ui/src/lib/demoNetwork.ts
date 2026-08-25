// Fixture fallback for the network security console. Rendered whenever the backend endpoints are
// absent (they are — nothing in Phase 3/4/5 is built), and ALWAYS carried with `source: "fixture"`
// so the pages can shout about it.
//
// TWO RULES, both learned the hard way:
//
// 1. NEVER let a fixture pass for live data. The IT module shipped 8 invented devices at
//    "Bali Office" on a 10.0.x.x range that does not exist in this office; they sat in the live
//    tenant for months and read as a topology bug. Hence `source` on every response and a banner on
//    every page.
//
// 2. NEVER commit staff-identifying data. The office scan on 2026-08-25 found 40 live hosts, and
//    ~25 of them are personal phones whose hostnames name the employee holding them
//    (`<name>-s-Galaxy-...`, `A56-milik-<name>`, `iphone-<name>`). Committing those to a fixture
//    file would put an employee-presence record in git — the exact thing the discovery design's
//    privacy gate (§6, D4) refuses to put in the DATABASE. So the corporate asset names below are
//    real (they are company property, and realism is the point of a visualization fixture), the
//    gateway is real, and every personal device is collapsed into an unnamed aggregate — which is
//    also precisely how the shipped product must treat them.
import type {
  TrafficResponse, ThreatsResponse, IsolationResponse, PresenceResponse,
} from "./network";

const MIN = 60_000;
const ago = (mins: number) => new Date(Date.now() - mins * MIN).toISOString();
const ahead = (mins: number) => new Date(Date.now() + mins * MIN).toISOString();

// Corporate hosts observed on GDA / 10.10.0.0/22, 2026-08-25. Company assets only.
const HOSTS = [
  { id: "fx-gw", name: "UDM-Enterprise (gateway)", ip: "10.10.0.1" },
  { id: "fx-05", name: "GDA-05", ip: "10.10.0.181" },
  { id: "fx-08", name: "GDA-08", ip: "10.10.0.201" },
  { id: "fx-09", name: "GDA-09", ip: "10.10.1.9" },
  { id: "fx-13", name: "GDA-13", ip: "10.10.1.92" },
  { id: "fx-15", name: "GDA-15", ip: "10.10.3.24" },
  { id: "fx-23", name: "GDA-23", ip: "10.10.3.12" },
  { id: "fx-aio", name: "GDA-AIO-02", ip: "10.10.3.139" },
  { id: "fx-mba", name: "MacBookAir", ip: "10.10.1.57" },
];
const h = (k: string) => HOSTS.find((x) => x.id === k)!;

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function traffic(): TrafficResponse {
  const r = (
    host: (typeof HOSTS)[number], destAsn: string, destCountry: string, app: string,
    bytesIn: number, bytesOut: number, sessions: number,
  ) => ({
    deviceId: host.id, deviceName: host.name, ip: host.ip,
    destAsn, destCountry, app, bytesIn, bytesOut, sessions,
  });
  return {
    source: "fixture",
    windowHours: 24,
    lastRun: { startedAt: ago(6), finishedAt: ago(5), ok: true, error: null },
    rollups: [
      r(h("fx-aio"), "AS15169 Google", "US", "Google Workspace", 14 * GB, 3 * GB, 4120),
      r(h("fx-aio"), "AS16509 Amazon", "SG", "S3 / backup", 900 * MB, 8 * GB, 210),
      r(h("fx-13"), "AS15169 Google", "US", "Google Workspace", 6 * GB, 1200 * MB, 2980),
      r(h("fx-13"), "AS13335 Cloudflare", "SG", "HTTPS", 2 * GB, 400 * MB, 1740),
      r(h("fx-mba"), "AS714 Apple", "US", "iCloud", 3 * GB, 2 * GB, 860),
      r(h("fx-05"), "AS15169 Google", "US", "YouTube", 9 * GB, 300 * MB, 620),
      r(h("fx-08"), "AS32934 Meta", "SG", "HTTPS", 1400 * MB, 260 * MB, 940),
      r(h("fx-09"), "AS13335 Cloudflare", "ID", "HTTPS", 800 * MB, 190 * MB, 1130),
      r(h("fx-15"), "AS4837 China Unicom", "CN", "Unclassified TCP/8291", 40 * MB, 620 * MB, 3180),
      r(h("fx-23"), "AS15169 Google", "US", "Google Workspace", 2 * GB, 500 * MB, 1490),
      r(h("fx-gw"), "AS17451 Biznet", "ID", "DNS / NTP", 300 * MB, 280 * MB, 21400),
      // An unregistered host moving real volume — the shape the registry alone can never show you.
      {
        deviceId: null, deviceName: "Unregistered host", ip: "10.10.2.231",
        destAsn: "AS9009 M247", destCountry: "NL", app: "Unclassified TCP/443",
        bytesIn: 120 * MB, bytesOut: 2 * GB, sessions: 88,
      },
    ],
  };
}

function threats(): ThreatsResponse {
  return {
    source: "fixture",
    lastRun: { startedAt: ago(6), finishedAt: ago(5), ok: true, error: null },
    threats: [
      {
        id: "fx-t1", occurredAt: ago(18), severity: "critical",
        signature: "ET TROJAN Possible Cobalt Strike beacon (outbound)",
        srcIp: "10.10.3.24", dstIp: "45.61.136.12", direction: "outbound",
        deviceId: "fx-15", deviceName: "GDA-15", action: "detected", triageState: "new",
      },
      {
        id: "fx-t2", occurredAt: ago(52), severity: "high",
        signature: "ET SCAN Suspicious inbound port sweep",
        srcIp: "185.220.101.4", dstIp: "10.10.0.1", direction: "inbound",
        deviceId: null, deviceName: null, action: "blocked", triageState: "new",
      },
      {
        id: "fx-t3", occurredAt: ago(140), severity: "high",
        signature: "ET POLICY Unencrypted credential over HTTP (internal)",
        srcIp: "10.10.2.231", dstIp: "10.10.0.201", direction: "internal",
        deviceId: null, deviceName: "Unregistered host", action: "detected", triageState: "investigating",
      },
      {
        id: "fx-t4", occurredAt: ago(320), severity: "medium",
        signature: "ET INFO Outdated TLS version negotiated",
        srcIp: "10.10.1.57", dstIp: "17.253.144.10", direction: "outbound",
        deviceId: "fx-mba", deviceName: "MacBookAir", action: "detected", triageState: "resolved",
      },
      {
        id: "fx-t5", occurredAt: ago(610), severity: "low",
        signature: "ET INFO DNS query to newly-registered domain",
        srcIp: "10.10.0.181", dstIp: "8.8.8.8", direction: "outbound",
        deviceId: "fx-05", deviceName: "GDA-05", action: "detected", triageState: "false_positive",
      },
    ],
  };
}

function isolations(): IsolationResponse {
  return {
    source: "fixture",
    // Phase 4 is not built. The page must not offer a control that would 404.
    enforcementEnabled: false,
    isolations: [
      {
        id: "fx-i1", deviceId: "fx-15", deviceName: "GDA-15", ip: "10.10.3.24",
        reason: "Outbound beacon to 45.61.136.12 (ET TROJAN, critical)",
        requestedBy: "H. Wijaya", approvedBy: null,
        appliedAt: null, expiresAt: null, revertedAt: null, state: "pending_approval",
      },
      {
        id: "fx-i2", deviceId: "fx-08", deviceName: "GDA-08", ip: "10.10.0.201",
        reason: "Credential seen in cleartext during incident review",
        requestedBy: "H. Wijaya", approvedBy: "IT Manager",
        appliedAt: ago(95), expiresAt: ahead(145), revertedAt: null, state: "active",
      },
      {
        id: "fx-i3", deviceId: "fx-05", deviceName: "GDA-05", ip: "10.10.0.181",
        reason: "Suspected scanning — later attributed to a vulnerability scanner",
        requestedBy: "IT Manager", approvedBy: "IT Manager",
        appliedAt: ago(2600), expiresAt: ago(2360), revertedAt: ago(2480), state: "reverted",
      },
    ],
  };
}

function presence(): PresenceResponse {
  return {
    source: "fixture",
    // No CSI hardware has been bought or chosen. Everything below is illustrative.
    hardwareDeployed: false,
    zones: [
      { zoneId: "fx-z1", name: "Main floor", occupancy: 11, confidence: 0.82, updatedAt: ago(1), sensorOnline: true },
      { zoneId: "fx-z2", name: "Meeting room A", occupancy: 3, confidence: 0.71, updatedAt: ago(2), sensorOnline: true },
      { zoneId: "fx-z3", name: "Server room", occupancy: 0, confidence: 0.94, updatedAt: ago(1), sensorOnline: true },
      { zoneId: "fx-z4", name: "Reception", occupancy: 1, confidence: 0.44, updatedAt: ago(38), sensorOnline: false },
    ],
  };
}

// Getters, not frozen literals: the relative timestamps ("5 min ago") must be computed at read
// time. Baking them at module load makes the demo feed look progressively more stale the longer the
// server has been up — which would trip the very staleness banner these fixtures exist to exercise.
export const NETWORK_FIXTURES = {
  get traffic() { return traffic(); },
  get threats() { return threats(); },
  get isolations() { return isolations(); },
  get presence() { return presence(); },
};
