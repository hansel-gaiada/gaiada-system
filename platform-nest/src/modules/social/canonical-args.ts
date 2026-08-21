// SMM-08 — the platform side of the D14 argument hash (addendum D-15).
//
// A post variant's `args_sha256` is NOT a module-private hash. It is the SAME value the MCP hub
// computes over a tool call's arguments (`mcp-hub/src/approval-grant.ts`), because that is what a
// single-use approval grant is bound to: at execution time the hub recomputes the hash over the
// ACTUAL call arguments and refuses if it does not match the one the approval was minted against.
// If this file and the hub ever disagree by a single byte, every approved publish fails at the
// grant check — or, far worse, a mismatched pair passes because someone "fixed" the check instead
// of the hash.
//
// So this is a deliberate, documented DUPLICATE of the hub's algorithm rather than a shared
// package: the two services are separate projects with no shared code layer (the program's
// standing rule — contracts travel over HTTP and docs, never a package). The safety net is that
// the hub PUBLISHES fixed vectors for exactly this purpose ("copy them into the platform-side
// test"), and `canonical-args.test.ts` asserts all three. A drift in either implementation breaks
// those vectors on the side that drifted.
//
// ── THE ALGORITHM (mirrored from the hub's header, which is the authority) ──────────────────────
//  1. object  -> "{" + entries.join(",") + "}", entries `JSON.stringify(key) + ":" + canon(value)`,
//                keys from `Object.keys(obj).sort()` — the DEFAULT sort, i.e. ascending UTF-16
//                code-unit order. NOT localeCompare (which is locale-sensitive and would make the
//                hash depend on the server's locale). Recursive at every depth.
//  2. array   -> "[" + elements.map(canon).join(",") + "]", ORDER PRESERVED (arrays are data, not
//                sets). An `undefined` element serializes as `null`, matching JSON.stringify.
//  3. string  -> `JSON.stringify(str)`: minimal escaping, non-ASCII emitted literally as UTF-8.
//                NO Unicode normalization — precomposed "é" and decomposed "é" hash DIFFERENTLY
//                and are deliberately treated as different arguments.
//  4. number  -> `JSON.stringify(n)` (shortest round-trip); NaN/±Infinity -> "null".
//  5. boolean -> "true"/"false";  null -> "null".
//  6. a key whose value is `undefined` is OMITTED entirely (as are function/symbol values).
//  7. no separators or indentation anywhere.
import { createHash } from "node:crypto";

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
      // JSON.stringify throws on bigint. Variant payloads are built from parsed JSON and DB rows,
      // so this cannot arrive from the wire — but crashing the hash path would take an approval
      // down with it, so serialize as a decimal string exactly as the hub does.
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
        if (encoded === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return undefined;
  }
}

/** Byte-for-byte the hub's `canonicalJson`. Top-level `undefined` canonicalizes to "null". */
export function canonicalJson(value: unknown): string {
  return canon(value) ?? "null";
}

/** Lowercase hex SHA-256 over the UTF-8 bytes of `canonicalJson(args)` — the hub's `argsSha256`. */
export function argsSha256(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

/** The publish-call arguments a variant's approval is bound to.
 *
 *  This shape IS the contract: it must be exactly what `social.publishPost` will be called with at
 *  execution time, or the grant check fails. Everything a human approves is in here — the content,
 *  the target account, the media, the network settings and the scheduled time — and nothing else.
 *
 *  What is deliberately EXCLUDED, and why it matters:
 *   - the variant's `status`, timestamps and `updated_at`: they change as the row moves through
 *     review, and including them would invalidate an approval for a state transition the approver
 *     already sanctioned.
 *   - anything server-derived at dispatch (the provider org id, the API key alias): the approver
 *     never saw them, so binding an approval to them would be binding it to something outside the
 *     decision.
 *
 *  The consequence is the design's state law, and it is structural rather than policed: any edit to
 *  the CONTENT changes the hash, which invalidates the approval; a status change does not. */
export interface VariantPublishArgs {
  tenantId: string;
  variantId: string;
  accountId: string;
  body: string;
  firstComment: string | null;
  media: unknown;
  settings: unknown;
  scheduledAt: string | null;
}

/** Build the canonical args for a variant. Nulls are kept EXPLICIT rather than omitted: a variant
 *  with no first comment and a variant whose first comment was deleted must hash identically, and
 *  leaving the key out on one path but not the other would make that depend on which code path
 *  built the object. */
export function variantPublishArgs(v: {
  tenantId: string;
  id: string;
  accountId: string;
  body: string;
  firstComment?: string | null;
  media?: unknown;
  settings?: unknown;
  scheduledAt?: Date | string | null;
}): VariantPublishArgs {
  const scheduled = v.scheduledAt instanceof Date ? v.scheduledAt.toISOString() : (v.scheduledAt ?? null);
  return {
    tenantId: v.tenantId,
    variantId: v.id,
    accountId: v.accountId,
    body: v.body ?? "",
    firstComment: v.firstComment ?? null,
    media: v.media ?? [],
    settings: v.settings ?? {},
    scheduledAt: scheduled,
  };
}

/** The hash stored on `social_post_variants.args_sha256` and re-checked at dispatch. */
export function variantArgsSha256(v: Parameters<typeof variantPublishArgs>[0]): string {
  return argsSha256(variantPublishArgs(v));
}

// ── SMM-17 — the reply-call arguments a message's approval is bound to ────────────────────────────
//
// Byte-for-byte the SAME idea as `VariantPublishArgs` above, for `social.sendReply` instead of
// `social.publishPost`: this shape IS the contract the hub's grant will be bound to, so it must be
// exactly what the tool will be called with at execution time. `threadId`/`accountId` travel
// alongside `messageId`/`body` for the SAME reason `VariantPublishArgs` carries `accountId` next to
// `variantId` — defense in depth against a mismapped join, not information the caller could not
// otherwise derive.
export interface ReplyDispatchArgs {
  tenantId: string;
  messageId: string;
  threadId: string;
  accountId: string;
  body: string;
}

/** Build the canonical args for a reply message. `body` is kept explicit (never omitted) for the
 *  same "a variant with no first comment must hash identically either way" reasoning
 *  `variantPublishArgs` states — an empty reply body and a missing one must hash the same. */
export function replyDispatchArgs(m: {
  tenantId: string;
  id: string;
  threadId: string;
  accountId: string;
  body: string;
}): ReplyDispatchArgs {
  return {
    tenantId: m.tenantId,
    messageId: m.id,
    threadId: m.threadId,
    accountId: m.accountId,
    body: m.body ?? "",
  };
}

/** The hash stored on `social_inbox_messages.args_sha256` and re-checked at dispatch — the SAME
 *  edit-invalidates-approval anchor (D-15) `variantArgsSha256` gives publish, applied to a reply. */
export function replyArgsSha256(m: Parameters<typeof replyDispatchArgs>[0]): string {
  return argsSha256(replyDispatchArgs(m));
}
