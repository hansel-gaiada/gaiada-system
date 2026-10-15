// DW-7h (FRONTEND-BFF-CONTRACT §52.5) — is this request's client address (§52.2) blocked for this company?
//
// `security_ip_blocks` is per company under FORCE RLS (tenant_isolation), so it is read in THAT company's context
// (`withTenants([tenantId])`); through `withGlobal` it would read zero rows and block nobody, silently. The active set
// of each company is kept for at most 10 seconds per process. A refusal counts a hit on the block, written at most once
// per block per 60 seconds and never in the way of the response.
import { isIP } from "node:net";
import { withTenants } from "../../db";
import { TtlLoader, WriteThrottle } from "./caches";

export const IP_BLOCK_CACHE_TTL_MS = 10_000;
export const IP_BLOCK_HIT_INTERVAL_MS = 60_000;
// Companies are few; the bound is there because the tenant id comes from the URL, so a caller could otherwise grow
// the map with every uuid it makes up.
const MAX_CACHED_TENANTS = 2_000;
const MAX_THROTTLED_BLOCKS = 5_000;

/**
 * One spelling per address, so the request's address and the block's compare equal however each was written.
 * Postgres prints IPv6 compressed (`host(ip)`), a browser's address arrives as whatever nginx or the socket wrote, and
 * `2001:DB8::1`, `2001:db8:0:0:0:0:0:1` and `2001:db8::0:1` are the same host. IPv6 is therefore expanded to eight
 * four-digit lowercase groups; an IPv4-mapped IPv6 address becomes its IPv4 form, as `cleanIp` does. Not an address:
 * null.
 */
export function ipKey(value: string | null | undefined): string | null {
  if (!value) return null;
  let s = value.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const kind = isIP(s);
  if (kind === 4) return s;
  if (kind !== 6) return null;
  // A dotted IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) becomes two hex groups first.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const o = tail.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length > 1 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = rest === null ? head : [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
  const full = groups.map((g) => g.padStart(4, "0")).join(":");
  if (full.startsWith("0000:0000:0000:0000:0000:ffff:")) {
    const [hi, lo] = groups.slice(6).map((g) => parseInt(g, 16));
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return full;
}

/** A company's active blocks, by `ipKey` of the address, to the block's id. */
export type ActiveBlocks = Map<string, string>;

export async function loadActiveBlocks(tenantId: string): Promise<ActiveBlocks> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ id: string; ip: string }>(
      `SELECT id, host(ip) AS ip FROM security_ip_blocks
        WHERE tenant_id = $1 AND lifted_at IS NULL AND expires_at > now()`,
      [tenantId],
    ),
  );
  const blocks: ActiveBlocks = new Map();
  for (const r of rows) {
    const k = ipKey(r.ip);
    if (k) blocks.set(k, r.id);
  }
  return blocks;
}

export async function writeBlockHits(tenantId: string, blockId: string, hits: number): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE security_ip_blocks SET hit_count = hit_count + $3, last_hit_at = now() WHERE id = $1 AND tenant_id = $2`,
      [blockId, tenantId, hits],
    ),
  );
}

export interface IpBlockGuard {
  /** The id of the active block on `ip` for this company, or null. A null address is never blocked. */
  blockFor(tenantId: string, ip: string | null): Promise<string | null>;
  /** Count one refused request on the block. Fire and forget: returns at once, never throws. */
  countHit(tenantId: string, blockId: string): void;
}

export function createIpBlockGuard(deps: {
  load?: (tenantId: string) => Promise<ActiveBlocks>;
  writeHits?: (tenantId: string, blockId: string, hits: number) => Promise<void>;
  now?: () => number;
} = {}): IpBlockGuard {
  const load = deps.load ?? loadActiveBlocks;
  const writeHits = deps.writeHits ?? writeBlockHits;
  const now = deps.now ?? Date.now;
  const cache = new TtlLoader<string, ActiveBlocks>(IP_BLOCK_CACHE_TTL_MS, MAX_CACHED_TENANTS, now);
  const throttle = new WriteThrottle<string>(IP_BLOCK_HIT_INTERVAL_MS, MAX_THROTTLED_BLOCKS, now);
  return {
    async blockFor(tenantId, ip) {
      const key = ipKey(ip);
      if (!key) return null;
      const blocks = await cache.get(tenantId, () => load(tenantId));
      return blocks.get(key) ?? null;
    },
    countHit(tenantId, blockId) {
      const hits = throttle.take(blockId);
      if (hits === 0) return;
      Promise.resolve().then(() => writeHits(tenantId, blockId, hits)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[security:ip-block-hit] could not count a hit on block ${blockId}:`, (err as Error)?.message ?? err);
      });
    },
  };
}
