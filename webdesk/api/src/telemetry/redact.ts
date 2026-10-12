// M4 telemetry — what a span may carry. PURE: no OpenTelemetry imports, so the redaction rules are testable
// (and auditable) on their own and cost nothing to load.
//
// THE THREAT. This api is internet-facing and two of its public routes carry a BEARER CREDENTIAL IN THE URL
// PATH: `/v1/t/<slug>/preview/<token>` (draft preview, WSK-46) and `/v1/t/<slug>/media/upload/<token>`
// (media upload, WSK-43a). The instrumentations record that path on a dozen attributes (url.path, url.full,
// http.target, http.url, the span name...). A span that reached the collector with the token in it would
// hand a draft-preview or upload capability to everything that can read traces. So every span is rewritten
// here, in ONE place (the exporter wrapper in sanitizing-exporter.ts, which sees each span's FINAL state,
// after instrumentations have renamed it and set their late attributes), before it leaves the process.
//
// The token rule itself is NOT re-implemented: `redactPreviewToken` (delivery/preview-token.ts), the function
// the log lines and problem `instance` members already use, finds the credential segment; this file only
// adds what a span needs on top (a `[redacted]` placeholder, slash collapsing, a shape-based backstop,
// query/userinfo removal, and the same treatment for every string a span can hold).
import type { AttributeValue, Attributes } from "@opentelemetry/api"; // types only: erased at compile time, nothing is loaded
import { redactPreviewToken } from "../delivery/preview-token";

export const REDACTED = "[redacted]";

/** The shape of every bearer token this api mints (32 random bytes, unpadded base64url). */
const TOKEN_SHAPED = /^[A-Za-z0-9_-]{43}$/;

/** A `/v1/t/...` path run inside a larger string (a span name, a message, a url). Stops at a query, a fragment, whitespace or a quote. */
const V1_PATH_IN_TEXT = /\/v1\/+t\/[^\s?#"'<>()]*/gi;

function decodedOrSelf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A URL PATH (no query, no fragment) with every credential segment replaced by `[redacted]`:
 *  1. the two known token routes, through `redactPreviewToken` (it compares the route word DECODED, as the
 *     router does, so `%70review` is covered). The router collapses `//` before matching, so a path with
 *     doubled slashes is collapsed first, otherwise the segment positions shift and the token slips past;
 *  2. a backstop for a route nobody has listed yet: any single segment shaped exactly like one of this api's
 *     tokens (43 base64url characters, decoded) is replaced too.
 * A path that held no credential is returned byte for byte.
 */
export function redactPath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  let out = redactPreviewToken(collapsed, REDACTED);
  out = out
    .split("/")
    .map((seg) => (TOKEN_SHAPED.test(decodedOrSelf(seg)) ? REDACTED : seg))
    .join("/");
  return out === collapsed ? path : out;
}

/** Strip the query and fragment from anything URL-like or target-like (`/a/b?x=1#y`). */
function stripQueryAndFragment(s: string): string {
  const q = s.search(/[?#]/);
  return q === -1 ? s : s.slice(0, q);
}

/**
 * A full URL for a span attribute: userinfo, query and fragment removed always. `pathMode` decides the path:
 * "token-routes" keeps it with credential segments redacted (our own server spans); "drop" replaces it with
 * `/[redacted]` (outbound calls: a tenant's webhook URL is the tenant's secret and S3 object keys are tenant data).
 */
export function redactUrl(raw: string, pathMode: "token-routes" | "drop"): string {
  try {
    const u = new URL(raw);
    const path = pathMode === "drop" ? `/${REDACTED}` : redactPath(u.pathname);
    // `host` keeps a non-default port; scheme://host is never a credential.
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    // Not an absolute URL (or not parseable): treat as a path-like string.
    const base = stripQueryAndFragment(raw);
    return pathMode === "drop" ? `/${REDACTED}` : redactPath(base);
  }
}

/** A request target or path attribute (`/v1/x?y=1`): query dropped, credential segments redacted. */
export function redactTarget(raw: string, pathMode: "token-routes" | "drop"): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return redactUrl(raw, pathMode);
  return pathMode === "drop" ? `/${REDACTED}` : redactPath(stripQueryAndFragment(raw));
}

/**
 * Any other string a span holds (its name, an attribute that is not a known URL field, an event message):
 * every `/v1/t/...` run inside it goes through the path rule. Text with no such run is returned unchanged.
 */
export function redactText(s: string): string {
  if (!s.includes("v1")) return s;
  return s.replace(V1_PATH_IN_TEXT, (run) => redactPath(run));
}

// ---------------------------------------------------------------------------------------------------------
// Attribute policy
// ---------------------------------------------------------------------------------------------------------

/** URL-valued attributes, old and new semantic conventions, plus the fastify instrumentation's `url.path`. */
const URL_KEYS = new Set(["url.full", "http.url"]);
const TARGET_KEYS = new Set(["url.path", "http.target", "http.route"]);

/**
 * Attributes that are NEVER exported, on any span: the query string (an api key may travel there), identity
 * and network details of the caller, request/response bodies and headers, SQL parameter values, exception
 * text (a database error message quotes the offending values), and the connection string.
 */
const DROP_KEYS = new Set([
  "url.query",
  "http.query",
  "http.user_agent",
  "user_agent.original",
  "client.address",
  "client.port",
  "http.client_ip",
  "http.request.body",
  "http.response.body",
  "db.statement.parameters",
  "db.query.parameters",
  "db.connection_string",
  "db.user",
  "exception.message",
  "exception.stacktrace",
  "hook.name", // @fastify/otel records the handler's SOURCE TEXT here
  "hook.callback.name",
  "net.sock.peer.addr",
  "net.sock.peer.port",
]);

/** Key prefixes never exported: every header attribute (Authorization, Cookie, x-api-key, the control gate header...) and any body attribute. */
const DROP_PREFIXES = ["http.request.header.", "http.response.header.", "http.request.body.", "http.response.body.", "db.query.parameter."];

/** On a SERVER span the peer address IS the caller's IP (personal data); on a CLIENT span it is the upstream. */
const SERVER_ONLY_DROP_KEYS = new Set(["network.peer.address", "network.peer.port", "net.peer.ip", "net.peer.port"]);

/** SpanKind numbers: INTERNAL 0, SERVER 1, CLIENT 2, PRODUCER 3, CONSUMER 4 (kept numeric so this file imports nothing). */
export const KIND_SERVER = 1;
export const KIND_CLIENT = 2;

export type Attrs = Attributes;

/** The attributes of one span (or event, or link), rewritten. Never mutates its input. */
export function redactAttributes(attrs: Attrs | undefined, kind: number): Attrs {
  const out: Attributes = {};
  if (!attrs) return out;
  const pathMode = kind === KIND_CLIENT ? "drop" : "token-routes";
  for (const [key, value] of Object.entries(attrs)) {
    const lk = key.toLowerCase();
    if (DROP_KEYS.has(lk) || DROP_PREFIXES.some((p) => lk.startsWith(p))) continue;
    if (kind === KIND_SERVER && SERVER_ONLY_DROP_KEYS.has(lk)) continue;
    if (typeof value === "string") {
      if (URL_KEYS.has(lk)) out[key] = redactUrl(value, pathMode);
      else if (TARGET_KEYS.has(lk)) out[key] = redactTarget(value, pathMode);
      else out[key] = redactText(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === "string" ? redactText(v) : v)) as AttributeValue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A span name: instrumentations put `GET /v1/t/acme/preview/<token>` there. */
export function redactName(name: string): string {
  return redactText(name);
}
