// ASST-22 — the `@drawer` mount's page-context pinning. Pure, client-safe (no `server-only`,
// no I/O): consumed by the FAB (a client component, needs `usePathname()`) AND by the intercepted
// drawer route (a server component, needs the same derivation to build the same ref shape). Kept
// in `lib/` per platform-ui's module-trio convention rather than inline in either caller, so the
// two never drift about what a "page context" IS.
//
// ── THE REF FORMAT IS NOT INVENTED HERE — SAME DISCIPLINE AS ASST-18's CITATIONS ──────────────────
// `derivePageContextRef` produces exactly the `erp:<kind>:<id>` shape
// `modules/knowledge/ingest/erp-source.ts` stamps on ingested chunks and
// `modules/assistant/citations.ts` already resolves (ASST-18's "existing typed-ref idea from the
// @-mention/citation work" — the ticket's own words for what this file should reuse rather than
// invent). Resolution happens server-side, in the drawer route, via the SAME
// `GET /api/:t/assistant/citations/:sourceRef` endpoint the citation chips already call
// (`resolvePageContextRef` in `lib/assistant-data.ts`) — this file only ever produces a CANDIDATE
// ref; it never claims the entity still exists (a deleted/renamed row 404s there exactly like an
// unresolvable citation, and the drawer opens with no pin rather than a fake one).
//
// `person` refs carry the tenant id INSIDE the ref (erp-source.ts's own convention, mirrored by
// citations.ts's embedded-tenant check) — this file needs the ACTIVE tenant to build one, which is
// why every call site passes it through explicitly rather than this file reaching for a cookie
// itself (it must stay import-safe from a plain client component).

export interface DerivedPageContext {
  kind: string;
  id: string;
  /** `erp:<kind>:<id>` (or `erp:person:<tenantId>:<id>`) — the exact wire shape citations.ts parses. */
  ref: string;
}

interface RoutePattern {
  re: RegExp;
  kind: string;
}

// Ordered MOST-SPECIFIC FIRST: a department-nested project/task route must match before the
// generic top-level pattern that would otherwise swallow its leading segment as a different kind.
const ROUTE_PATTERNS: RoutePattern[] = [
  { re: /^\/departments\/[^/]+\/projects\/[^/]+\/tasks\/([^/?#]+)/, kind: "task" },
  { re: /^\/departments\/[^/]+\/projects\/([^/?#]+)/, kind: "project" },
  { re: /^\/projects\/([^/?#]+)/, kind: "project" },
  { re: /^\/tasks\/([^/?#]+)/, kind: "task" },
  { re: /^\/clients\/([^/?#]+)/, kind: "client" },
  { re: /^\/meetings\/([^/?#]+)/, kind: "meeting" },
  { re: /^\/people\/([^/?#]+)/, kind: "person" },
];

// A "new" segment (`/projects/new`, `/tasks/new`, …) is a create form, not an existing entity —
// there is nothing to pin yet.
const NON_ENTITY_IDS = new Set(["new"]);

/** Maps the CURRENT app pathname to a candidate typed context ref, or `null` on a page with no
 *  resolvable entity (a list page, settings, home) — the drawer opens with no pin rather than a
 *  guessed one. `tenantId` is required only for a `person` ref (see file header); every other kind
 *  ignores it. */
export function derivePageContextRef(pathname: string | null | undefined, tenantId: string | null): DerivedPageContext | null {
  if (!pathname) return null;
  for (const { re, kind } of ROUTE_PATTERNS) {
    const m = re.exec(pathname);
    if (!m) continue;
    const rawId = m[m.length - 1];
    if (!rawId) return null;
    const id = decodeURIComponent(rawId);
    if (NON_ENTITY_IDS.has(id)) return null;
    if (kind === "person") {
      if (!tenantId) return null;
      return { kind, id, ref: `erp:person:${tenantId}:${id}` };
    }
    return { kind, id, ref: `erp:${kind}:${id}` };
  }
  return null;
}

/** The FAB's own `href` for the current page — `/assistant` (the intercepted route's target) with
 *  the derived ref (if any) carried as `?ctx=`. This is the ONLY channel the drawer route has for
 *  learning what page it was opened from: it is a parallel-route slot that renders alongside
 *  whatever page is already mounted (`(app)/layout.tsx`'s `children` never re-renders on this
 *  navigation), so `usePathname()` read INSIDE the drawer would report `/assistant` itself, not the
 *  page the user was actually on. Capturing it here, at the trigger, is what makes that fact not
 *  matter. */
export function assistantDrawerHref(pathname: string | null | undefined, tenantId: string | null): string {
  const ctx = derivePageContextRef(pathname, tenantId);
  return ctx ? `/assistant?ctx=${encodeURIComponent(ctx.ref)}` : "/assistant";
}

/** The one-time preamble prepended to the FIRST outgoing message of a thread opened with a page
 *  context pinned. Mirrors aivory's `AiraFloatingAssistant`/`AivoryAssistant.tsx` `contextPrefix`
 *  (`[Context: user is on the ${page} page]`, applied only when `messages.length === 0`) — same
 *  idea, typed against a real resolved entity instead of a bare page name, and sent as plain text
 *  because the backend's message-send contract has no separate structured-context field to carry it
 *  in (see `AssistantWorkspace`'s header for why this is composition over the existing `content`
 *  field, not a new wire shape). Persisted as-is, so the transcript honestly shows what context the
 *  assistant was given — never hidden from the user who sent it. */
export function pageContextPrefix(label: string, ref: string): string {
  return `[Context: ${label} (${ref})]\n\n`;
}
