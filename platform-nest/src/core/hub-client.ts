// D14-03 — the platform's OUTBOUND side of the mcp-hub contract: mint a single-use execution grant
// and re-drive one approved tool call through the hub as the ORIGINAL filing principal.
//
// Contract: `docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md` §1 (architect-fixed).
// The verifying half is `mcp-hub/src/approval-grant.ts` (D14-04, shipped). Neither side may change
// the contract unilaterally, and this file must MIRROR that one — see CANONICAL JSON below.
//
// ── WHY MINTING LIVES HERE AND NOT IN approval-execute.ts ─────────────────────────────────────────
// The grant is a HUB WIRE ARTIFACT: its value, its claim spellings and its digest algorithm are all
// part of the same protocol as the `x-approval-grant` header that carries it. Keeping the serializer
// next to the request it feeds means a reviewer checking "do the two services agree?" reads one file.
// The executor decides WHEN a grant may exist (only inside a won `pending -> executing` claim, which
// is what makes single-use authoritative); this file only knows HOW to spell one.
//
// ── CANONICAL JSON — MUST match mcp-hub/src/approval-grant.ts BYTE FOR BYTE ────────────────────────
// A mismatch here is a deny-EVERYTHING bug that no happy-path test on either side would catch on its
// own: the hub recomputes `argsSha256` over the arguments it actually received and rejects the grant
// on any difference, so the row would land `failed` with `args_mismatch` forever. The three fixed
// vectors at the bottom of this comment are asserted in `approval-execute.test.ts` and are copied
// from the hub's own test file — they are the cross-service check that the two implementations agree.
//
// `argsSha256` = lowercase-hex SHA-256 of the UTF-8 bytes of `canonicalJson(args)`, where
// canonicalJson is a MANUAL serializer — deliberately NOT `JSON.stringify` over a rebuilt
// key-sorted object, because JS orders integer-like keys ("2" before "10") ahead of string keys
// regardless of insertion order, which would bake a V8 property-order quirk into a cross-service
// contract:
//   1. object  -> "{" + entries.join(",") + "}", each entry `JSON.stringify(key) + ":" + canon(value)`,
//                 keys from `Object.keys(o).sort()` — the DEFAULT ascending UTF-16 code-unit sort,
//                 NOT localeCompare. Recursive at every depth.
//   2. array   -> "[" + elements.map(canon).join(",") + "]"; ORDER PRESERVED (arrays are data, not
//                 sets); an `undefined` element becomes `null`, matching JSON.stringify.
//   3. string  -> `JSON.stringify(str)`: only `"`, `\` and C0 controls escaped; every other code
//                 point emitted literally as UTF-8. NO NFC/NFKC normalization — precomposed "é" and
//                 decomposed "é" are deliberately DIFFERENT arguments and hash differently.
//   4. number  -> `JSON.stringify(n)` (shortest round-trip form; `-0` -> `0`); NaN/±Infinity -> "null".
//   5. boolean -> "true"/"false"; null -> "null".
//   6. object keys whose value is `undefined` / a function / a symbol are OMITTED entirely; there is
//      no whitespace anywhere (no space after `:` or `,`).
//   7. top-level `undefined` -> "null" (unreachable in practice: `tool_args` defaults to `{}`).
//
// Fixed vectors (identical to mcp-hub/src/approval-grant.test.ts):
//   {}                              -> "{}"
//     44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
//   { b:1, a:{ d:1, c:[3,{y:2,x:1}] } } -> {"a":{"c":[3,{"x":1,"y":2}],"d":1},"b":1}
//     f2b017ad2046767a1fb4a845843b145aef66713aa8adef3952e980dc15f44ce4
//   { runId:"r1", repo:"acme/site" }    -> {"repo":"acme/site","runId":"r1"}
//     756a6e9ac2f5873539d73f9a95008a46ed673573ade26e86ff42a6b27b1f9dad
//
// ── CANONICAL PRODUCER SPELLINGS (§1, pinned 2026-08-05) ──────────────────────────────────────────
// `iat`/`exp` in epoch MILLISECONDS, `argsSha256` as LOWERCASE HEX, signature as BASE64URL. The
// shipped verifier is deliberately liberal (it also accepts seconds, uppercase hex, base64), but this
// producer emits ONLY the canonical forms — being liberal is the verifier's job, not the minter's.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "../config";

/** The transport header (§1). Must match `mcp-hub/src/approval-grant.ts`'s APPROVAL_GRANT_HEADER. */
export const APPROVAL_GRANT_HEADER = "x-approval-grant";

/**
 * `exp - iat` for a minted grant. The contract allows up to 120s and the verifier rejects only
 * `window > 120_000`, so 60s sits comfortably inside it while leaving the other 60s as headroom
 * against clock skew between the two containers: with a 30s hub-call timeout (below), a hub clock up
 * to ~30s AHEAD of ours still sees a live grant. Minting at exactly the 120s ceiling would make every
 * grant depend on that boundary being inclusive in a service we do not own.
 */
export const GRANT_WINDOW_MS = 60_000;

/** Per-attempt ceiling on the re-driven tool call. Generous (a deploy dispatch is not a page render)
 *  but finite: without it a hung hub would hold the row at `executing` until the process restarts,
 *  which is the crash-wedge state and needs a human retry to leave. */
export const HUB_CALL_TIMEOUT_MS = 30_000;

// ─────────────────────────────────── canonical JSON + args digest ────────────────────────────────

/** One value, canonically serialized. `undefined` for values JSON.stringify omits from objects. */
function canon(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return undefined;
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      // JSON.stringify throws on bigint. `tool_args` arrives from jsonb (parsed JSON), so this cannot
      // occur from the wire — mirrored from the hub's verifier so the two never disagree even here.
      return JSON.stringify(value.toString());
    case "function":
    case "symbol":
      return undefined;
    case "object": {
      if (Array.isArray(value)) return `[${value.map((el) => canon(el) ?? "null").join(",")}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const encoded = canon(obj[key]);
        if (encoded === undefined) continue; // JSON.stringify drops undefined-valued keys
        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return undefined;
  }
}

/** Canonical JSON per the algorithm in this file's header. */
export function canonicalJson(value: unknown): string {
  return canon(value) ?? "null";
}

/** SHA-256 over canonicalJson(args), lowercase hex — the canonical `argsSha256` spelling. */
export function computeArgsSha256(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

// ────────────────────────────────────────── grant minting ────────────────────────────────────────

export interface ExecutionGrantPayload {
  v: 1;
  approvalId: string;
  tenantId: string;
  toolName: string;
  argsSha256: string;
  /** Epoch MILLISECONDS (canonical). */
  iat: number;
  /** Epoch MILLISECONDS (canonical); `exp - iat === GRANT_WINDOW_MS`. */
  exp: number;
  nonce: string;
}

export interface MintedExecutionGrant {
  /** The `x-approval-grant` header value: base64url(payloadJson) + "." + base64url(hmac). */
  header: string;
  payload: ExecutionGrantPayload;
}

export class ApprovalGrantNotConfiguredError extends Error {
  constructor() {
    super(
      "APPROVAL_GRANT_SECRET is not set — no execution grant can be minted, so an approved " +
        "automation write cannot be re-driven (fail closed).",
    );
  }
}

/**
 * Mint ONE single-use grant for exactly this (approval, tenant, tool, args).
 *
 * Callers MUST only reach this from inside a won `pending -> executing` claim (see
 * `core/approval-execute.ts`): the platform-side claim is the AUTHORITATIVE single-use guarantee, and
 * the hub's nonce cache is a best-effort second wall (§5.7). A fresh nonce per ATTEMPT is required,
 * not per row — the hub burns a nonce on the first accepted use, so a retry presenting the same
 * nonce would be rejected as `replayed_nonce`.
 *
 * Throws when the secret is unset rather than emitting an unsigned or empty-key grant: an empty HMAC
 * key produces a perfectly valid MAC over the wrong key space, which the hub would reject as
 * `bad_signature` — the same outcome, but recorded as a signature failure instead of the
 * configuration failure it actually is.
 */
export function mintExecutionGrant(input: {
  approvalId: string;
  tenantId: string;
  toolName: string;
  args: Record<string, unknown>;
  now?: number;
}): MintedExecutionGrant {
  const secret = config.approvalGrantSecret;
  if (!secret) throw new ApprovalGrantNotConfiguredError();
  const iat = input.now ?? Date.now();
  const payload: ExecutionGrantPayload = {
    v: 1,
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    toolName: input.toolName,
    argsSha256: computeArgsSha256(input.args),
    iat,
    exp: iat + GRANT_WINDOW_MS,
    // 128 bits of randomness: the nonce is a replay key, never a counter or an id derived from the
    // row (a derived nonce would be identical across attempts and self-replay on the first retry).
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return { header: `${encoded}.${mac}`, payload };
}

// ──────────────────────────────────────── the tool call ──────────────────────────────────────────

/** The OBO envelope the hub mints its principal from. NEVER the approver's identity — see
 *  `core/approval-execute.ts`'s authority rule. */
export interface HubObo {
  provider: string;
  externalId: string;
}

/**
 * Outcome of one re-driven tool call, classified so the executor can record a TYPED
 * `execution_error` and decide whether a retry could possibly help.
 *
 *  - `ok`         — the tool ran; `text` is its return payload.
 *  - `denied`     — the hub refused (assurance, workflow scope, Cerbos, or a rejected grant). The
 *                   tool did NOT run. `text` is the hub's own reason string, kept verbatim: it is
 *                   the only place a human learns WHICH wall stopped it.
 *  - `tool_error` — the hub allowed the call and the tool itself threw. The tool MAY have partially
 *                   applied, so this is the outcome a blind retry must never assume is safe.
 *  - `transport`  — we never got a verdict: unreachable hub, non-2xx, timeout, unparsable body. The
 *                   call may or may not have happened, which is exactly why the retry path
 *                   re-evaluates the precondition instead of just re-sending.
 */
export type HubCallOutcome =
  | { kind: "ok"; text: string }
  | { kind: "denied"; text: string }
  | { kind: "tool_error"; text: string }
  | { kind: "transport"; text: string };

/** True when the hub is reachable at all (fail-soft convention: an unset URL/token is a
 *  configuration state the caller reports honestly, never a call against a phantom host). */
export function hubConfigured(): boolean {
  return !!(config.services.hub.url && config.services.hub.token);
}

/** Does this hub reason string mean "refused before the tool ran"? The hub's own spellings:
 *  `denied: …`, `suspend: …`, `denied by policy: …`, `unknown tool: …` (policy.ts / hub.ts). */
function isDenialText(text: string): boolean {
  return /^(denied|suspend|unknown tool)\b/i.test(text.trim());
}

/**
 * One JSON-RPC `tools/call` against the hub's stateless `/mcp` endpoint, carrying the OBO envelope
 * and (when given) the execution grant. Same wire shape the bot and the agent runner already use
 * (`wa-chat-bot/src/hub.ts`, `ai-agents/src/deps.ts`) — deliberately NOT a new protocol: responses
 * arrive SSE-framed from StreamableHTTPServerTransport, so both framings are handled.
 *
 * Never throws for a hub-side outcome; every failure is a classified `HubCallOutcome` so the caller
 * always has something typed to record on the row.
 */
export async function callHubTool(input: {
  toolName: string;
  args: Record<string, unknown>;
  obo: HubObo;
  grantHeader?: string;
  timeoutMs?: number;
}): Promise<HubCallOutcome> {
  if (!hubConfigured()) {
    // Prefixed with the executor's `not_configured` class on purpose (approval-execute.ts's
    // describeOutcome passes an already-classified text through unchanged): an unfinished deployment
    // must not be recorded as if the hub were down.
    return { kind: "transport", text: "not_configured: HUB_URL / HUB_SERVICE_TOKEN unset" };
  }
  const base = config.services.hub.url.replace(/\/$/, "");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), input.timeoutMs ?? HUB_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${config.services.hub.token}`,
        "x-obo-provider": input.obo.provider,
        "x-obo-external-id": input.obo.externalId,
        ...(input.grantHeader ? { [APPROVAL_GRANT_HEADER]: input.grantHeader } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        // The hub hashes `req.params.arguments ?? {}` — so what we hash for the grant and what we
        // send here must be the SAME value. Do not add, drop or reshape a field between the two.
        params: { name: input.toolName, arguments: input.args },
      }),
      signal: ac.signal,
    });
    if (!res.ok) return { kind: "transport", text: `hub HTTP ${res.status}` };
    const raw = await res.text();
    const rpc = parseRpcBody(raw);
    if (!rpc) return { kind: "transport", text: "hub returned an unparsable body" };
    if (rpc.error) return { kind: "transport", text: `hub rpc error: ${rpc.error.message ?? "unknown"}` };
    const text = rpc.result?.content?.[0]?.text ?? "";
    if (rpc.result?.isError) return isDenialText(text) ? { kind: "denied", text } : { kind: "tool_error", text };
    return { kind: "ok", text };
  } catch (err) {
    const msg = (err as Error)?.name === "AbortError" ? `timed out after ${input.timeoutMs ?? HUB_CALL_TIMEOUT_MS}ms` : ((err as Error)?.message ?? "unknown");
    return { kind: "transport", text: `hub unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

interface RpcBody {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
  error?: { message?: string };
}

/** Accepts both framings: a plain JSON body, or SSE (`event: message` / `data: {...}`). */
function parseRpcBody(raw: string): RpcBody | null {
  const body = raw.trim();
  if (!body) return null;
  const source = body.startsWith("{") ? body : (body.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "");
  if (!source) return null;
  try {
    return JSON.parse(source) as RpcBody;
  } catch {
    return null;
  }
}
