// WSK-60 — read the staging site's build stamp, and decide what it proves.
//
// The site's pull step (gaiada-web-revamp scripts/webdesk/pull.mjs, WSK-55) writes
// `dist/webdesk-build.json` = { source, pulledAt, maxUpdatedAt, itemCount, sourceSha256 }; the deploy
// puts it at `<stagingUrl>/webdesk-build.json`. The git build ships the committed `{"source":"git"}`.
// This file is the ERP's ONLY outbound call for WSK-60 (a GET of that one URL, which comes from
// config or, since M6-P6h, from the site's own registry row, a canonical public host name checked by
// site-build-targets.ts#siteUrlOf; never from a request), and it is listed as such in egress-inventory.test.ts.
// The GET refuses redirects and caps the body at 8 KiB, whatever the host.
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
//
// ── M6-P6h: A TEMPLATE-BUILT SITE'S STAMP (the rule is decided here, and only here) ─────────────────
// The site templates (webdesk/templates/_deploy/write-stamp.sh, M6-P6f) build through the vendored SDK and never
// enumerate the content, so their stamp has NO maxUpdatedAt (null, honestly) and its `pulledAt` is the instant the
// build began. What it does carry is `buildId` (which marks it as a template stamp), the `environment` it was built
// for, and, for an ERP dispatch, the `approvalId` the dispatch sent. The ERP cannot know the buildId in advance (a
// dispatch answers 204 with no run id), so the approval id is the handle that ties a served build to a dispatch:
//
//   a template stamp proves a build ONLY when ALL hold:
//     source === "webdesk"; its `environment`, if it says one, is the build's (staging for publish/rebuild,
//     production for promote); it has a `pulledAt`; it names an `approvalId` (a push-triggered build names none and
//     proves nothing for a dispatch); for a publish with a known publishedAt, pulledAt >= publishedAt truncated to the
//     second (the stamp's own precision);
//   and EITHER its approvalId is THIS build's (by "approvalId": the run this dispatch started, which pulled the content
//     after the publish was already live, because the ERP dispatches only after Zone B confirmed it),
//   OR (staging only) it is a LATER ERP dispatch's for the same site: the poller looked up that approval's ledger row and
//     its dispatchedAt is at or after this build's, and pulledAt >= this build's dispatchedAt truncated to the second (by
//     "laterDispatch"). That run began after this one was dispatched, so it pulled everything this one would have. This
//     is what settles a run GitHub dropped from the concurrency group (it keeps one WAITING run per group, so a third
//     dispatch replaces the second): the replacement carries the dropped run's content, and its stamp says so.
//   A promote has no "laterDispatch": every promote is its own decision, and a second one is refused while one is in
//   flight (site-builds.service.ts#startSitePromote).
// A stamp WITHOUT buildId (the proof site's WSK-55 stamp) keeps the two rules above, unchanged; a promote is never
// proved by one.
import { config } from "../../config";

export interface BuildStamp {
  source: string;
  pulledAt: Date | null;
  maxUpdatedAt: Date | null;
  itemCount: number | null;
  /** M6-P6h: the template stamp's run handle (`<run id>-<attempt>-<sha12>`). Absent (undefined or null) on the proof site's
   *  WSK-55 stamp; its presence is what makes a stamp a TEMPLATE stamp. */
  buildId?: string | null;
  /** M6-P6h: the approval the ERP's dispatch sent (`inputs.approval_id`); absent for a push-triggered build. */
  approvalId?: string | null;
  /** M6-P6h: `staging` or `production`, the environment the template built for. */
  environment?: string | null;
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
      buildId: shortToken(o.buildId, /^[A-Za-z0-9._-]{1,64}$/),
      approvalId: shortToken(o.approvalId, /^[A-Za-z0-9-]{8,64}$/),
      environment: shortToken(o.environment, /^[a-z]{1,20}$/),
    },
  };
}

/** A short identifier the stamp may carry, or null when it is absent or not of the expected shape (never coerced). */
function shortToken(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
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
  kind: "publish" | "rebuild" | "promote";
  publishedAt: Date | null;
  dispatchedAt: Date;
  /** M6-P6h: this build's approval (the ledger's `approval_id`). Needed to prove a build by a template stamp. */
  approvalId?: string | null;
  /** M6-P6h: the environment dispatched to. Defaults from the kind: production for promote, staging otherwise. */
  environment?: "staging" | "production";
  /** M6-P6h, staging only: the dispatch time of the ledger row of the approval a served TEMPLATE stamp names, when that row is
   *  another staging build of the same site (the poller looks it up; null when there is none). */
  coveringDispatchedAt?: Date | null;
}

export type Proof =
  | { proved: true; by: "maxUpdatedAt" | "pulledAt" | "approvalId" | "laterDispatch" }
  | { proved: false; why: string };

const floorToSecond = (d: Date): number => Math.floor(d.getTime() / 1000) * 1000;

/** Does this stamp prove the build? Pure. The only function that can say "live". */
export function stampProves(stamp: BuildStamp, build: ProofInput): Proof {
  if (stamp.source !== "webdesk") return { proved: false, why: `stamp source is "${stamp.source}", not a WebDesk build` };
  if (typeof stamp.buildId === "string" && stamp.buildId !== "") return templateStampProves(stamp, build);
  if (build.kind === "promote") return { proved: false, why: "a promote is proved only by a template build stamp that names its approval" };
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

/** The M6-P6h rule for a template stamp (see this file's header). */
function templateStampProves(stamp: BuildStamp, build: ProofInput): Proof {
  const env = build.environment ?? (build.kind === "promote" ? "production" : "staging");
  if (stamp.environment && stamp.environment !== env) {
    return { proved: false, why: `the served build is a ${stamp.environment} build, not ${env}` };
  }
  if (!stamp.pulledAt) return { proved: false, why: "stamp has no pulledAt" };
  if (!stamp.approvalId) return { proved: false, why: "the served build names no approval: no ERP dispatch started it (a push)" };
  if (build.kind === "publish" && build.publishedAt && stamp.pulledAt.getTime() < floorToSecond(build.publishedAt)) {
    return { proved: false, why: "the served build began before the publish" };
  }
  if (build.approvalId && stamp.approvalId.toLowerCase() === build.approvalId.toLowerCase()) {
    return { proved: true, by: "approvalId" };
  }
  if (
    build.kind !== "promote" &&
    build.coveringDispatchedAt &&
    build.coveringDispatchedAt.getTime() >= build.dispatchedAt.getTime() &&
    stamp.pulledAt.getTime() >= floorToSecond(build.dispatchedAt)
  ) {
    return { proved: true, by: "laterDispatch" };
  }
  return { proved: false, why: "the served build is another run's, not one dispatched at or after this one" };
}
