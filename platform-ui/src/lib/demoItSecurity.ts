import "server-only";
// DEMO_MODE fixtures for IT > Network, the ERP side (DW-7h, BFF §52). The dispatcher is lib/demoFixtures.ts (the DW-7h block).
//
// WHY THESE ARE EXPLICIT. The dispatcher's final GET catch-all answers every unmatched path with `ok([])`, an ARRAY; each reader
// here expects an OBJECT and checks its shape, so falling through would render the four pages as "cannot be read" (the right
// behaviour for a drifted backend, the wrong one for a demo).
//
// STATEFUL in memory, so the three writes can be driven in a browser: a sign-out marks the connection, a block adds a row and
// flags the connections from that address, a lift undoes it. It mirrors the server's refusals closely enough for the forms to
// show every state: your own session, your own address, a private address, an address people share (with `confirmShared`), a
// block that exists, a block that is not active.
//
// The data is chosen to cover the states, not the happy path: a repeated-failure alert, a new-device alert, an active block, a
// connection from a blocked address, a signed-out session, a session with no id and an address three people share.

interface DemoResultish {
  status: number;
  json: unknown;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

/** The demo signed-in person's own address and session: the server refuses ending or blocking these (409). */
const OWN_IP = "203.0.113.10";
const OWN_SESSION = "demo-sid-hansel";
const OWN_NAME = "Hansel";
type Actor = { userId: string; displayName: string };
const OWN: Actor = { userId: "demo-hansel", displayName: OWN_NAME };

type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";
interface Conn {
  userId: string; displayName: string; email: string; sessionId: string; ip: string | null; userAgent: string;
  device: { browser: string; os: string; kind: DeviceKind };
  firstAgo: number; lastAgo: number; requestCount: number; revoked: boolean;
}
const SHARED_IP = "198.51.100.50"; // an office NAT: three people
const BLOCKED_IP = "192.0.2.45";

const CONNS: Conn[] = [
  { userId: "demo-hansel", displayName: "Hansel", email: "hansel@gaiada.example", sessionId: OWN_SESSION, ip: OWN_IP, userAgent: "Mozilla/5.0 (Macintosh) Chrome/126",
    device: { browser: "Chrome", os: "macOS 14", kind: "desktop" }, firstAgo: 5 * HOUR, lastAgo: 1 * MIN, requestCount: 412, revoked: false },
  { userId: "u-dewi", displayName: "Dewi Lestari", email: "dewi@gaiada.example", sessionId: "demo-sid-dewi-1", ip: "198.51.100.24", userAgent: "Mozilla/5.0 (iPhone) Safari/17",
    device: { browser: "Safari", os: "iOS 17", kind: "mobile" }, firstAgo: 2 * HOUR, lastAgo: 9 * MIN, requestCount: 38, revoked: false },
  { userId: "u-putu", displayName: "Putu Aditya", email: "putu@gaiada.example", sessionId: "demo-sid-putu-1", ip: SHARED_IP, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/126",
    device: { browser: "Chrome", os: "Windows 11", kind: "desktop" }, firstAgo: 7 * HOUR, lastAgo: 14 * MIN, requestCount: 207, revoked: false },
  { userId: "u-ayu", displayName: "Ayu Prameswari", email: "ayu@gaiada.example", sessionId: "demo-sid-ayu-1", ip: SHARED_IP, userAgent: "Mozilla/5.0 (Windows NT 10.0) Edg/126",
    device: { browser: "Edge", os: "Windows 11", kind: "desktop" }, firstAgo: 6 * HOUR, lastAgo: 22 * MIN, requestCount: 154, revoked: false },
  { userId: "u-komang", displayName: "Komang Surya", email: "komang@gaiada.example", sessionId: "demo-sid-komang-1", ip: SHARED_IP, userAgent: "Mozilla/5.0 (Macintosh) Safari/17",
    device: { browser: "Safari", os: "macOS 14", kind: "desktop" }, firstAgo: 6 * HOUR, lastAgo: 41 * MIN, requestCount: 96, revoked: false },
  { userId: "u-made", displayName: "Made Arta", email: "made@gaiada.example", sessionId: "demo-sid-made-1", ip: BLOCKED_IP, userAgent: "Mozilla/5.0 (X11; Linux) Firefox/127",
    device: { browser: "Firefox", os: "Linux", kind: "desktop" }, firstAgo: 20 * HOUR, lastAgo: 3 * HOUR, requestCount: 12, revoked: false },
  { userId: "u-gede", displayName: "Gede Mahendra", email: "gede@gaiada.example", sessionId: "demo-sid-gede-1", ip: "198.51.100.88", userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/126",
    device: { browser: "Chrome", os: "Android 14", kind: "mobile" }, firstAgo: 30 * HOUR, lastAgo: 26 * HOUR, requestCount: 61, revoked: true },
  { userId: "u-wayan", displayName: "Wayan Sari", email: "wayan@gaiada.example", sessionId: "", ip: null, userAgent: "",
    device: { browser: "Unknown", os: "Unknown", kind: "unknown" }, firstAgo: 3 * DAY, lastAgo: 5 * HOUR, requestCount: 9, revoked: false },
];

/** A moment: seeded ones are "so long before this request" (negative: after it), so the demo always reads as live; ones made in
 *  the session are fixed (`at`), so a block made now does not slide forward with the clock. */
type Time = { ago: number } | { at: number };
const when = (t: Time, now: number) => ("at" in t ? t.at : now - t.ago);

interface Block {
  id: string; ip: string; reason: string; createdAt: Time; expiresAt: Time; liftedAt: Time | null;
  hitCount: number; lastHitAt: Time | null; liftedBy: Actor | null;
}
let blockSeq = 100;
const blocks: Block[] = [
  { id: "demo-block-1", ip: BLOCKED_IP, reason: "Repeated sign-in guessing from a hosting provider", createdAt: { ago: 2 * HOUR }, expiresAt: { ago: -22 * HOUR }, liftedAt: null, hitCount: 14, lastHitAt: { ago: 25 * MIN }, liftedBy: null },
  { id: "demo-block-2", ip: "203.0.113.99", reason: "Scanner found in the logs", createdAt: { ago: 4 * DAY }, expiresAt: { ago: -3 * DAY }, liftedAt: { ago: 3 * DAY + 2 * HOUR }, hitCount: 3, lastHitAt: { ago: 3 * DAY + 3 * HOUR }, liftedBy: OWN },
  // Never lifted: it ran out, which the page words as "Ran out" (the server only marks it lifted when the next block is made).
  { id: "demo-block-3", ip: "198.51.100.200", reason: "Contractor's old home address", createdAt: { ago: 9 * DAY }, expiresAt: { ago: 2 * DAY }, liftedAt: null, hitCount: 0, lastHitAt: null, liftedBy: null },
];

interface Rev { id: string; userId: string; displayName: string; email: string; sessionId: string | null; revokedAt: Time; reason: string | null }
let revSeq = 100;
const revocations: Rev[] = [
  { id: "demo-rev-1", userId: "u-gede", displayName: "Gede Mahendra", email: "gede@gaiada.example", sessionId: "demo-sid-gede-1", revokedAt: { ago: 1 * DAY }, reason: "Phone was lost" },
  { id: "demo-rev-2", userId: "u-leaver", displayName: "Rina Kusuma", email: "rina@gaiada.example", sessionId: null, revokedAt: { ago: 3 * DAY }, reason: null },
];

const connAt = (c: Conn, now: number) => ({
  who: { userId: c.userId, displayName: c.displayName, email: c.email }, sessionId: c.sessionId, ip: c.ip, userAgent: c.userAgent || null,
  device: c.device, firstSeenAt: iso(now - c.firstAgo), lastSeenAt: iso(now - c.lastAgo), requestCount: c.requestCount,
  revoked: c.revoked, ipBlocked: c.ip !== null && isActive(c.ip, now),
});
const isActiveBlock = (b: Block, now: number) => b.liftedAt === null && when(b.expiresAt, now) > now;
const isActive = (ip: string, now: number) => blocks.some((b) => b.ip === ip && isActiveBlock(b, now));
const blockAt = (b: Block, now: number) => ({
  id: b.id, ip: b.ip, reason: b.reason, active: isActiveBlock(b, now), createdAt: iso(when(b.createdAt, now)), createdBy: OWN, expiresAt: iso(when(b.expiresAt, now)),
  liftedAt: b.liftedAt === null ? null : iso(when(b.liftedAt, now)), hitCount: b.hitCount,
  lastHitAt: b.lastHitAt === null ? null : iso(when(b.lastHitAt, now)), liftedBy: b.liftedBy,
});

const WINDOW_MS: Record<string, number> = { "15m": 15 * MIN, "24h": DAY, "7d": 7 * DAY };
const windowOf = (raw: string | null, allowed: readonly string[], fallback: string): string | null => {
  if (raw === null) return fallback;
  return allowed.includes(raw) ? raw : null;
};
const bad = (): DemoResultish => ({ status: 400, json: { error: "window must be 15m, 24h or 7d", field: "window" } });

/** Failed sign-ins: six for Putu within 15 minutes (the high alert), a few elsewhere, and some for a username nobody has. */
function signInEvents(now: number) {
  const ev: { ago: number; type: "sign_in" | "failed" | "sign_out"; userId: string | null; email: string | null; ip: string | null; error: string | null }[] = [
    { ago: 1 * MIN, type: "sign_in", userId: "demo-hansel", email: "hansel@gaiada.example", ip: OWN_IP, error: null },
    { ago: 9 * MIN, type: "sign_in", userId: "u-dewi", email: "dewi@gaiada.example", ip: "198.51.100.24", error: null },
    { ago: 3 * HOUR, type: "sign_in", userId: "u-made", email: "made@gaiada.example", ip: BLOCKED_IP, error: null },
    { ago: 7 * HOUR, type: "sign_in", userId: "u-putu", email: "putu@gaiada.example", ip: SHARED_IP, error: null },
    { ago: 6 * HOUR, type: "sign_in", userId: "u-ayu", email: "ayu@gaiada.example", ip: SHARED_IP, error: null },
    { ago: 5 * HOUR, type: "sign_out", userId: "u-komang", email: "komang@gaiada.example", ip: SHARED_IP, error: null },
    { ago: 2 * DAY, type: "sign_in", userId: "u-gede", email: "gede@gaiada.example", ip: "198.51.100.88", error: null },
  ];
  for (let i = 0; i < 6; i += 1) {
    ev.push({ ago: 50 * MIN + i * 2 * MIN, type: "failed", userId: "u-putu", email: "putu@gaiada.example", ip: "192.0.2.77", error: "invalid_user_credentials" });
  }
  ev.push({ ago: 4 * HOUR, type: "failed", userId: "u-ayu", email: "ayu@gaiada.example", ip: SHARED_IP, error: "invalid_user_credentials" });
  return ev.map((e) => ({ at: iso(now - e.ago), type: e.type, userId: e.userId, email: e.email, ip: e.ip, error: e.error }));
}

function alertsFor(now: number) {
  return [
    { kind: "failed_signins_account", severity: "high", at: iso(now - 40 * MIN), subject: { userId: "u-putu", email: "putu@gaiada.example", ip: "192.0.2.77" }, detail: "6 failed sign-ins within 15 minutes", count: 6 },
    { kind: "new_device", severity: "medium", at: iso(now - 2 * HOUR), subject: { userId: "u-dewi", email: "dewi@gaiada.example", ip: "198.51.100.24" }, detail: "First connection from Safari on iOS at this address; Dewi Lestari has connected before", count: 1 },
    { kind: "blocked_ip_hits", severity: "low", at: iso(now - 25 * MIN), subject: { ip: BLOCKED_IP }, detail: `The block on ${BLOCKED_IP} stopped 14 requests`, count: 14 },
  ];
}

const PRIVATE_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validIp = (ip: string) => (IPV4_RE.test(ip) && ip.split(".").every((n) => Number(n) <= 255)) || (ip.includes(":") && /^[0-9a-f:]+$/i.test(ip));

export function itSecurityDemo(method: string, path: string, params: URLSearchParams, body: string | undefined): DemoResultish | null {
  const m = method.toUpperCase();
  const match = /^\/api\/([^/]+)\/it\/security\/(.+)$/.exec(path);
  if (!match) return null;
  const rest = match[2];
  const now = Date.now();

  if (m === "GET") {
    if (rest === "connections") {
      const w = windowOf(params.get("window"), ["15m", "24h", "7d"], "24h");
      if (!w) return bad();
      const connections = CONNS.filter((c) => c.lastAgo <= WINDOW_MS[w]).sort((a, b) => a.lastAgo - b.lastAgo).map((c) => connAt(c, now));
      return { status: 200, json: { asOf: iso(now), window: w, connections } };
    }
    if (rest === "sign-ins") {
      const w = windowOf(params.get("window"), ["24h", "7d"], "24h");
      if (!w) return bad();
      const events = signInEvents(now).filter((e) => now - Date.parse(e.at) <= WINDOW_MS[w]);
      const failed = events.filter((e) => e.type === "failed");
      const by = <K extends string>(rows: typeof failed, key: (e: (typeof failed)[number]) => K | null) => {
        const counts = new Map<K, number>();
        for (const e of rows) { const k = key(e); if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1); }
        return counts;
      };
      const byAccount = by(failed, (e) => e.userId);
      const byIp = by(failed, (e) => e.ip);
      const emailOf = (id: string) => events.find((e) => e.userId === id)?.email ?? null;
      return {
        status: 200,
        json: {
          asOf: iso(now), window: w, state: "on", events,
          summary: {
            signIns: events.filter((e) => e.type === "sign_in").length, failed: failed.length,
            failedByAccount: [...byAccount].map(([userId, count]) => ({ userId, email: emailOf(userId), count })),
            failedByIp: [...byIp].map(([ip, count]) => ({ ip, count })),
          },
          unknownAccounts: { failed: 3 },
        },
      };
    }
    if (rest === "alerts") {
      const w = windowOf(params.get("window"), ["15m", "24h", "7d"], "24h");
      if (!w) return bad();
      const alerts = alertsFor(now).filter((a) => now - Date.parse(a.at) <= WINDOW_MS[w]);
      return { status: 200, json: { asOf: iso(now), window: w, signIns: "on", alerts } };
    }
    if (rest === "blocks") {
      const ordered = [...blocks].sort((a, b) => Number(isActiveBlock(b, now)) - Number(isActiveBlock(a, now)) || when(b.createdAt, now) - when(a.createdAt, now));
      return {
        status: 200,
        json: {
          ipBlocks: ordered.map((b) => blockAt(b, now)),
          revokedSessions: revocations.map((r) => ({
            id: r.id, who: { userId: r.userId, displayName: r.displayName, email: r.email }, sessionId: r.sessionId, reason: r.reason,
            revokedAt: iso(when(r.revokedAt, now)), revokedBy: OWN, expiresAt: iso(when(r.revokedAt, now) + 13 * HOUR),
          })),
        },
      };
    }
    return null;
  }

  if (m !== "POST") return null;

  const revoke = /^sessions\/([^/]+)\/revoke$/.exec(rest);
  if (revoke) {
    const sid = decodeURIComponent(revoke[1]);
    const b = JSON.parse(body || "{}") as { userId?: string; reason?: string };
    const conn = CONNS.find((c) => c.sessionId === sid && c.userId === b.userId);
    if (!conn) return { status: 404, json: { error: "That session was never seen in this company.", reason: "session_not_found" } };
    if (sid === OWN_SESSION) {
      return { status: 409, json: { error: "That is your own session. Use Sign out in the top bar instead.", reason: "revokes_yourself" } };
    }
    conn.revoked = true;
    revSeq += 1;
    revocations.unshift({ id: `demo-rev-${revSeq}`, userId: conn.userId, displayName: conn.displayName, email: conn.email, sessionId: sid, revokedAt: { at: now }, reason: b.reason ?? null });
    return { status: 200, json: { revoked: true, keycloak: "ended" } };
  }

  if (rest === "blocks") {
    const b = JSON.parse(body || "{}") as { ip?: string; reason?: string; hours?: number; confirmShared?: boolean };
    const ip = (b.ip ?? "").trim();
    if (!validIp(ip)) return { status: 400, json: { error: "That is not a valid network address.", field: "ip", reason: "invalid" } };
    if (PRIVATE_RE.test(ip) || ip === "::1") {
      return { status: 400, json: { error: "That is a private address. Blocking it would not stop anyone outside the network.", field: "ip", reason: "private" } };
    }
    if (ip === OWN_IP) return { status: 409, json: { error: "That is your own address. Blocking it would lock you out.", reason: "blocks_yourself" } };
    if (isActive(ip, now)) return { status: 409, json: { error: `${ip} is already blocked.`, reason: "already_blocked" } };
    const users = new Set(CONNS.filter((c) => c.ip === ip && c.lastAgo <= DAY).map((c) => c.userId)).size;
    if (users >= 3 && !b.confirmShared) {
      return { status: 409, json: { error: `${users} people connected from this address in the last 24 hours.`, reason: "shared_address", detail: { users } } };
    }
    const hours = b.hours ?? 24;
    blockSeq += 1;
    const created: Block = {
      id: `demo-block-${blockSeq}`, ip, reason: b.reason ?? "", createdAt: { at: now }, expiresAt: { at: now + hours * HOUR }, liftedAt: null,
      hitCount: 0, lastHitAt: null, liftedBy: null,
    };
    blocks.unshift(created);
    return { status: 201, json: blockAt(created, now) };
  }

  const lift = /^blocks\/([^/]+)\/lift$/.exec(rest);
  if (lift) {
    const block = blocks.find((x) => x.id === decodeURIComponent(lift[1]));
    if (!block) return { status: 404, json: { error: "No such block.", reason: "block_not_found" } };
    if (!isActiveBlock(block, now)) return { status: 409, json: { error: "That block is no longer active.", reason: "not_active" } };
    block.liftedAt = { at: now };
    block.liftedBy = OWN;
    return { status: 200, json: blockAt(block, now) };
  }
  return null;
}
