// M5-P5b — pluggable verification of an AI-crawler claim. A User-Agent is trivially forged, so when a vendor
// publishes the IP ranges its crawler uses, a claim from outside them is marked "unverified" (still counted, kept
// apart in the panel). The IP is only used here, in memory, and never stored.
//
// The ranges are NOT bundled in the repo: vendors change them, and a stale list would mark real crawlers as
// spoofed. Ops supplies them as a JSON file (see infra/runbooks/ai-crawler-log.md for how to build it from the
// vendors' published lists) and points AI_CRAWLER_RANGES_FILE at it. With no file the verifier is off and every row
// is "claimed". A bot that has no entry in the file is also "claimed" (nothing to check it against).
//
// Another strategy (reverse DNS, a vendor API) is just another CrawlerVerifier; nothing here is special-cased.
import { BlockList, isIP } from "node:net";
import { readFileSync } from "node:fs";
import type { CrawlerVerifier } from "./ai-crawler-log";

export type CrawlerRanges = Record<string, string[]>;

function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

/** A verifier over CIDR ranges per bot id. A bot with ranges: inside = verified, outside or no IP = unverified. */
export function createRangeVerifier(ranges: CrawlerRanges): CrawlerVerifier {
  const lists = new Map<string, BlockList>();
  for (const [bot, cidrs] of Object.entries(ranges)) {
    if (!Array.isArray(cidrs) || cidrs.length === 0) continue;
    const bl = new BlockList();
    for (const c of cidrs) {
      const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(String(c).trim());
      if (!m) continue;
      const fam = isIP(m[1]);
      if (!fam) continue;
      const max = fam === 4 ? 32 : 128;
      const prefix = m[2] === undefined ? max : Number(m[2]);
      if (prefix > max) continue;
      if (prefix === max) bl.addAddress(m[1], fam === 4 ? "ipv4" : "ipv6");
      else bl.addSubnet(m[1], prefix, fam === 4 ? "ipv4" : "ipv6");
    }
    lists.set(bot, bl);
  }
  return (ip, bot) => {
    const bl = lists.get(bot.id);
    if (!bl) return "claimed";
    if (!ip) return "unverified";
    const addr = normalizeIp(ip);
    const fam = isIP(addr);
    if (!fam) return "unverified";
    return bl.check(addr, fam === 4 ? "ipv4" : "ipv6") ? "verified" : "unverified";
  };
}

/** The verifier configured on this server, or undefined (verification off). A broken file turns verification off
 *  loudly in the log rather than failing ingest. */
export function verifierFromEnv(env: NodeJS.ProcessEnv = process.env): CrawlerVerifier | undefined {
  const file = env.AI_CRAWLER_RANGES_FILE;
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object of bot id to CIDR list");
    return createRangeVerifier(parsed as CrawlerRanges);
  } catch (e) {
    console.warn(`ai-crawler: AI_CRAWLER_RANGES_FILE unreadable, verification is off (${(e as Error).message})`);
    return undefined;
  }
}
