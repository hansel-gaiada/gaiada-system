// DW-7h (FRONTEND-BFF-CONTRACT §52.3) — record who reached a company's data, from which address and on what browser:
// one `security_access_seen` row per (company, user, Keycloak session, address). IT's "Connected" page and the
// new-device alert read it.
//
// It is bookkeeping on the hot path, so it may never cost the request anything: at most one write per key per 60
// seconds per process (a bounded map), the write is not awaited, and a failed write is logged and dropped. Each write
// adds the requests held back since the key's last write, so `request_count` still counts requests.
import { withTenants } from "../../db";
import { WriteThrottle } from "./caches";

export const ACCESS_WRITE_INTERVAL_MS = 60_000;
export const ACCESS_THROTTLE_MAX_KEYS = 20_000;

export interface AccessSeen {
  tenantId: string;
  userId: string;
  /** The token's `sid`, or '' when there is none (the key column is NOT NULL DEFAULT ''). */
  sessionId: string;
  /** null when the address could not be told; the key is NULLS NOT DISTINCT, so that is still one row. */
  ip: string | null;
  userAgent: string | null;
}

export async function writeAccessSeen(row: AccessSeen, requests: number): Promise<void> {
  // In the company's context because the table is under FORCE RLS. The `companies` guard makes a made-up tenant id in
  // the URL a no-op instead of a foreign-key error in the log: the tenant id is the caller's, and Cerbos has not yet
  // decided anything about it when this runs.
  await withTenants([row.tenantId], (c) =>
    c.query(
      `INSERT INTO security_access_seen (tenant_id, user_id, session_id, ip, user_agent, request_count)
       SELECT $1::uuid, $2::uuid, $3::text, $4::inet, $5::text, $6::bigint WHERE EXISTS (SELECT 1 FROM companies WHERE id = $1::uuid)
       ON CONFLICT ON CONSTRAINT ux_security_access_seen_key DO UPDATE
          SET user_agent = COALESCE(EXCLUDED.user_agent, security_access_seen.user_agent),
              last_seen_at = now(),
              request_count = security_access_seen.request_count + EXCLUDED.request_count`,
      [row.tenantId, row.userId, row.sessionId.slice(0, 200), row.ip, row.userAgent, requests],
    ),
  );
}

export interface AccessRecorder {
  /** Note one request. Returns at once; never throws. */
  record(row: AccessSeen): void;
}

export function createAccessRecorder(deps: {
  write?: (row: AccessSeen, requests: number) => Promise<void>;
  now?: () => number;
  maxKeys?: number;
} = {}): AccessRecorder {
  const write = deps.write ?? writeAccessSeen;
  const throttle = new WriteThrottle<string>(ACCESS_WRITE_INTERVAL_MS, deps.maxKeys ?? ACCESS_THROTTLE_MAX_KEYS, deps.now);
  return {
    record(row) {
      const requests = throttle.take(`${row.tenantId}|${row.userId}|${row.sessionId}|${row.ip ?? ""}`);
      if (requests === 0) return;
      Promise.resolve().then(() => write(row, requests)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[security:access-seen] could not record a connection for user ${row.userId}:`, (err as Error)?.message ?? err);
      });
    },
  };
}
