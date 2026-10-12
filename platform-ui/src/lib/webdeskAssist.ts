import "server-only";
// M5-W6 — the writers' room AI assist: the call and its wire validation (server-only half; the types, words and apply rules are in
// `webdeskAssistModel.ts`, the action the editor calls is `webdeskAssistActions.ts`). Same rules as `webdeskContent.ts`, whose `wire` and
// `problemOf` this reuses: EVERY 2xx body is validated before it is returned, a body that does not match is `drift` (never rendered as
// suggestions), and no failure turns into an empty list of suggestions.
//
// Why not `wdCall`: its `WdResult` has no place for the typed answers assist needs (a 429's `retryAfterSeconds`, a 503's `reason`, a
// 422's `reason`); `resultFromError` folds them into a generic "unavailable". Assist maps its own, here, and only here.
//
//   POST …/sites/:tenantSlug/:siteId/items/:itemId/assist   {kind, version?}      (docs/FRONTEND-BFF-CONTRACT.md, M5-W6)
//
// NOTHING IS LOGGED HERE: no prompt, suggestion, title or error body (the BFF keeps the same rule).
import { PlatformError, platformFetch } from "./platform";
import { problemOf, siteBase, wire, WireDrift } from "./webdeskContent";
import {
  ASSIST_KINDS, isAssistKind,
  type AssistBody, type AssistFailure, type AssistKind, type AssistResult, type AssistSuggestion, type AssistUsage,
} from "./webdeskAssistModel";

const { str, int, bool, nullable, arr, obj, key, opt } = wire;
const strN = nullable(str);

const MAX_SUGGESTIONS = 50;

function parseSuggestion(kind: AssistKind): (v: unknown, path: string) => AssistSuggestion {
  return (v, path) => {
    const o = obj(v, path);
    const id = key(o, "id", str, path);
    switch (kind) {
      case "meta_description":
        return { id, kind, target: key(o, "target", str, path), text: key(o, "text", str, path), length: key(o, "length", int, path) };
      case "outline": {
        const headings = key(o, "headings", arr((h, p) => {
          const ho = obj(h, p);
          return { level: key(ho, "level", int, p), text: key(ho, "text", str, p) };
        }), path);
        return { id, kind, headings, markdown: key(o, "markdown", str, path) };
      }
      case "faq":
        return { id, kind, question: key(o, "question", str, path), answer: key(o, "answer", str, path) };
      case "translate_draft":
        return {
          id, kind, sourcePath: key(o, "sourcePath", str, path), field: key(o, "field", str, path), locale: key(o, "locale", str, path),
          text: key(o, "text", str, path), notice: opt(o, "notice", str, path) ?? "",
        };
      case "alt_text":
        return { id, kind, target: key(o, "target", str, path), index: key(o, "index", int, path), imageRef: key(o, "imageRef", str, path), alt: key(o, "alt", str, path) };
    }
  };
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `usage` is information, not a decision: a missing or odd one is `null`, never drift. */
function parseUsage(v: unknown): AssistUsage | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const u = v as Record<string, unknown>;
  return { callsUsed: numOrNull(u.callsUsed), callsLimit: numOrNull(u.callsLimit), tokensEstimatedUsed: numOrNull(u.tokensEstimatedUsed), tokensLimit: numOrNull(u.tokensLimit) };
}

export function parseAssist(v: unknown): AssistBody {
  const p = "assist";
  const o = obj(v, p);
  const kindRaw = key(o, "kind", str, p);
  if (!isAssistKind(kindRaw)) throw new WireDrift(`${p}.kind`, `one of ${ASSIST_KINDS.join("|")}`, kindRaw);
  // Suggestions are ADVICE. A body that does not say so is not rendered as suggestions.
  if (key(o, "advisory", bool, p) !== true) throw new WireDrift(`${p}.advisory`, "true", o.advisory);
  const raw = key(o, "suggestions", (x, path) => {
    if (!Array.isArray(x)) throw new WireDrift(path, "array", x);
    if (x.length > MAX_SUGGESTIONS) throw new WireDrift(path, `at most ${MAX_SUGGESTIONS} suggestions`, x);
    return x;
  }, p);
  const suggestions = raw.map((s, i) => parseSuggestion(kindRaw)(s, `${p}.suggestions[${i}]`));
  // The suggestion ids are how a UI tells them apart: a repeated one would make "Apply" ambiguous.
  if (new Set(suggestions.map((s) => s.id)).size !== suggestions.length) throw new WireDrift(`${p}.suggestions`, "unique ids", "duplicate");
  // An empty list is a CLAIM ("nothing to suggest"), and the BFF never sends one with a 200: it answers 422 or 502. Treat it as drift.
  if (suggestions.length === 0) throw new WireDrift(`${p}.suggestions`, "at least one suggestion", "empty");
  return {
    kind: kindRaw,
    itemId: key(o, "itemId", str, p),
    version: key(o, "version", nullable(int), p),
    headVersion: key(o, "headVersion", nullable(int), p),
    locale: key(o, "locale", str, p),
    suggestions,
    notice: opt(o, "notice", strN, p) ?? null,
    provider: typeof o.provider === "string" ? o.provider : null,
    usage: parseUsage(o.usage),
  };
}

const finiteSeconds = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** One place that turns the BFF's refusals into `AssistFailure`. Nothing in the result carries the response body. */
export function assistFailureOf(e: unknown): AssistFailure {
  if (e instanceof WireDrift) return { kind: "drift", reason: e.message };
  if (!(e instanceof PlatformError)) return { kind: "unreachable" };
  const p = problemOf(e);
  switch (e.status) {
    case 400:
      return { kind: "bad_request", message: p.message };
    case 401:
      return { kind: "session" };
    case 403:
      return { kind: "forbidden" };
    case 404:
      // A route this deployment does not serve (no such module/route) is "not available", not "this item is gone".
      return p.slug === "item-not-found" || p.slug === "version-not-found" || p.slug === "site-not-found" ? { kind: "not_found" } : { kind: "unavailable", reason: "not_served" };
    case 409:
      return p.slug === "item-deleted" ? { kind: "deleted" } : { kind: "bad_request", message: p.message };
    case 422:
      return p.slug === "assist-not-applicable"
        ? { kind: "not_applicable", reason: typeof p.ext.reason === "string" ? p.ext.reason : null }
        : { kind: "bad_request", message: p.message };
    case 429:
      return { kind: "budget", retryAfterSeconds: finiteSeconds(p.ext.retryAfterSeconds) };
    case 502:
      return p.slug === "assist-output-invalid" ? { kind: "invalid_output" } : { kind: "unreachable" };
    case 503:
      return { kind: "unavailable", reason: typeof p.ext.reason === "string" ? p.ext.reason : null };
    default:
      return { kind: "unreachable" };
  }
}

export async function runAssist(
  userId: string, company: string, tenantSlug: string, siteId: string, itemId: string, kind: AssistKind, version?: number,
): Promise<AssistResult> {
  let raw: unknown;
  try {
    raw = await platformFetch<unknown>(
      `${siteBase(company, tenantSlug, siteId)}/items/${encodeURIComponent(itemId)}/assist`, userId,
      { method: "POST", body: JSON.stringify(version === undefined ? { kind } : { kind, version }) },
    );
  } catch (e) {
    return { ok: false, failure: assistFailureOf(e) };
  }
  try {
    const data = parseAssist(raw);
    // A body for another kind or item than the one asked for is not an answer to this call.
    if (data.kind !== kind) throw new WireDrift("assist.kind", kind, data.kind);
    if (data.itemId !== itemId) throw new WireDrift("assist.itemId", "the requested item", "another item");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, failure: assistFailureOf(e) };
  }
}
