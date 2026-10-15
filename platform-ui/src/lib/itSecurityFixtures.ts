// DW-7h: shared builders for the IT > Network tests (the four pages and the controls). Test-only; nothing in the app imports it.
import type { Alert, AlertsAnswer, BlocksAnswer, Connection, ConnectionsAnswer, IpBlock, Revocation, SignInEvent, SignInsAnswer } from "./itSecurity";
import { me as meFixture, member } from "./workspaceFixtures";

export const ASOF = "2026-10-15T09:00:00.000Z";
const minutesAgo = (n: number) => new Date(Date.parse(ASOF) - n * 60_000).toISOString();

/** An IT admin of `co-a` (holds `it.manage` there), and a plain member (does not). */
export const itAdmin = meFixture([member(), { role: "it_admin", scopeType: "company", scopeId: "co-a" }]);
export const plainMember = meFixture([member()]);

export const conn = (over: Partial<Connection> = {}): Connection => ({
  who: { userId: "u-dewi", displayName: "Dewi Lestari", email: "dewi@x.test" }, sessionId: "sid-dewi", ip: "198.51.100.24", userAgent: "UA",
  device: { browser: "Safari", os: "iOS 17", kind: "mobile" }, firstSeenAt: minutesAgo(120), lastSeenAt: minutesAgo(9), requestCount: 38,
  revoked: false, ipBlocked: false, ...over,
});
export const connections = (rows: Connection[], over: Partial<ConnectionsAnswer> = {}): ConnectionsAnswer => ({ asOf: ASOF, window: "24h", connections: rows, ...over });

export const event = (over: Partial<SignInEvent> = {}): SignInEvent => ({ at: minutesAgo(30), type: "failed", userId: "u-putu", email: "putu@x.test", ip: "192.0.2.77", error: "invalid_user_credentials", ...over });
export const signInsOn = (events: SignInEvent[] = [event()], over: Partial<Extract<SignInsAnswer, { state: "on" }>> = {}): SignInsAnswer => ({
  asOf: ASOF, window: "24h", state: "on", events,
  summary: {
    signIns: events.filter((e) => e.type === "sign_in").length, failed: events.filter((e) => e.type === "failed").length,
    failedByAccount: [{ userId: "u-putu", email: "putu@x.test", count: events.filter((e) => e.type === "failed").length }],
    failedByIp: [{ ip: "192.0.2.77", count: events.filter((e) => e.type === "failed").length }],
  },
  unknownAccounts: { failed: 3 }, ...over,
});

export const alert = (over: Partial<Alert> = {}): Alert => ({
  kind: "failed_signins_account", severity: "high", at: minutesAgo(40), subject: { userId: "u-putu", email: "putu@x.test", ip: "192.0.2.77" },
  detail: "6 failed sign-ins within 15 minutes", count: 6, ...over,
});
export const alerts = (rows: Alert[], signIns: AlertsAnswer["signIns"] = "on"): AlertsAnswer => ({ asOf: ASOF, window: "24h", signIns, alerts: rows });

export const block = (over: Partial<IpBlock> = {}): IpBlock => ({
  id: "b-1", ip: "192.0.2.45", reason: "Repeated sign-in guessing", active: true, createdAt: minutesAgo(120), createdBy: { userId: "u-1", displayName: "Hansel" },
  expiresAt: new Date(Date.parse(ASOF) + 22 * 3_600_000).toISOString(), liftedAt: null, liftedBy: null, hitCount: 14, lastHitAt: minutesAgo(25), ...over,
});
export const revocation = (over: Partial<Revocation> = {}): Revocation => ({
  id: "r-1", who: { userId: "u-gede", displayName: "Gede", email: "gede@x.test" }, sessionId: "s", reason: "Phone lost", revokedAt: "2026-10-14T09:00:00Z",
  revokedBy: { userId: "u-1", displayName: "Hansel" }, expiresAt: "2026-10-14T22:00:00Z", ...over,
});
export const blocks = (ipBlocks: IpBlock[], revokedSessions: BlocksAnswer["revokedSessions"] = []): BlocksAnswer => ({ ipBlocks, revokedSessions });
