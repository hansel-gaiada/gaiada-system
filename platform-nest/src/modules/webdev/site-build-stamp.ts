// WSK-60 — read the staging site's build stamp, and decide what it proves.
//
// The site's pull step (gaiada-web-revamp scripts/webdesk/pull.mjs, WSK-55) writes
// `dist/webdesk-build.json` = { source, pulledAt, maxUpdatedAt, itemCount, sourceSha256 }; the deploy
// puts it at `<stagingUrl>/webdesk-build.json`. The git build ships the committed `{"source":"git"}`.
// This file is the ERP's ONLY outbound call for WSK-60 (a GET of that one URL, which comes from
// config, never from a request), and it is listed as such in egress-inventory.test.ts.
//
// ── WHAT A STAMP PROVES (design §9, "Shows it") ──────────────────────────────────────────────────
//   publish with a known publishedAt:  source === "webdesk" AND maxUpdatedAt ≥ publishedAt.
//     `maxUpdatedAt` is the newest meta.updatedAt in the pulled content, so a stamp at or past the
//     publish instant came from a pull that already included it. This uses only frozen-envelope data.
//   anything else (a rebuild, or a publish whose publishedAt is unknown because the answer was lost):
//     source === "webdesk" AND pulledAt ≥ dispatchedAt. A pull that began before the dispatch cannot be
//     the build this dispatch started, and a pull after it read content that was already published
//     (or already unpublished: an unpublish moves no item's updatedAt past anything, so
//     maxUpdatedAt cannot witness it, which is why a rebuild is proven by when the pull happened).
// An unchanged stamp (the old build still serving), a `{"source":"git"}` stamp, an unreachable site,
// malformed JSON and a missing field all prove NOTHING: they leave the build `rebuilding`, and the
// poll window closing turns that into `unverified`. There is no path from "could not read it" to
// `live`.
import { config } from "../../config";

export interface BuildStamp {
  source: string;
  pulledAt: Date | null;
  maxUpdatedAt: Date | null;
  itemCount: number | null;
}

export type StampRead =
  | { ok: true; stamp: BuildStamp }
  | { ok: false; reason: "unreachable" | "http_status" | "not_json" | "malformed" };

export interface StampFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cache-buster so no intermediary answers with the previous deploy's stamp. */
  nonce?: string;
}

const MAX_STAMP_BYTES = 8 * 1024;

function asDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Validate a parsed stamp body. Exported for the unit tests. */
export function parseStamp(body: unknown): StampRead {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "malformed" };
  const o = body as Record<string, unknown>;
  if (typeof o.source !== "string" || o.source === "") return { ok: false, reason: "malformed" };
  return {
    ok: true,
    stamp: {
      source: o.source,
      pulledAt: asDate(o.pulledAt),
      maxUpdatedAt: asDate(o.maxUpdatedAt),
      itemCount: typeof o.itemCount === "number" && Number.isFinite(o.itemCount) ? o.itemCount : null,
    },
  };
}

/** GET `<stagingUrl>/webdesk-build.json`. Never throws; every failure is a typed `ok: false`. */
export async function readStagingStamp(stagingUrl: string, opts: StampFetchOptions = {}): Promise<StampRead> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${stagingUrl.replace(/\/+$/, "")}/webdesk-build.json${opts.nonce ? `?t=${encodeURIComponent(opts.nonce)}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? config.webdeskRebuild.stampTimeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "http_status" };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (text.length > MAX_STAMP_BYTES) return { ok: false, reason: "malformed" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: "not_json" };
    }
    return parseStamp(json);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProofInput {
  kind: "publish" | "rebuild";
  publishedAt: Date | null;
  dispatchedAt: Date;
}

export type Proof = { proved: true; by: "maxUpdatedAt" | "pulledAt" } | { proved: false; why: string };

/** Does this stamp prove the build? Pure. The only function that can say "live". */
export function stampProves(stamp: BuildStamp, build: ProofInput): Proof {
  if (stamp.source !== "webdesk") return { proved: false, why: `stamp source is "${stamp.source}", not a WebDesk build` };
  if (build.kind === "publish" && build.publishedAt) {
    if (!stamp.maxUpdatedAt) return { proved: false, why: "stamp has no maxUpdatedAt" };
    return stamp.maxUpdatedAt.getTime() >= build.publishedAt.getTime()
      ? { proved: true, by: "maxUpdatedAt" }
      : { proved: false, why: "stamp maxUpdatedAt is older than publishedAt" };
  }
  if (!stamp.pulledAt) return { proved: false, why: "stamp has no pulledAt" };
  return stamp.pulledAt.getTime() >= build.dispatchedAt.getTime()
    ? { proved: true, by: "pulledAt" }
    : { proved: false, why: "stamp was pulled before this dispatch" };
}
