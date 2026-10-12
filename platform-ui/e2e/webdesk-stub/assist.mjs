// M5-W6 — the stubbed writers' room AI assist (POST …/items/:itemId/assist), as a pure in-memory model for e2e/webdesk-assist.spec.ts.
// TEST FIXTURE ONLY: nothing under `src/` imports it. Transcribed from docs/FRONTEND-BFF-CONTRACT.md (M5-W6): the 200 body, the per-kind
// suggestion shapes, and the typed answers. It decides NOTHING about the content (the canned suggestions are fixed text), and it WRITES
// NOTHING: it records each call and counts every OTHER write that reaches the stub, so the spec can prove that Apply saved nothing.
//
// Who may call it: the same rule as the real route (`update` on the item). In this stub's roles that is the publisher tier; a viewer is the
// BFF's 403 before the body is looked at (handled by `handleWebdesk`'s own write gate, which runs first).
//
// Scenario controls (POST /__stub/config): `assistRefuse: "budget" | "unavailable" | "not-applicable" | "output-invalid" | "deleted"` (the NEXT
// call is refused with that typed answer; one-shot). The generic `delayMs` (POST /__stub/config) slows every route, assist included.

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const R = (status, json) => ({ status, json });
const problem = (status, slug, title, detail, extra = {}) => R(status, { type: `${PROBLEM}${slug}`, title, status, detail, instance: "/stub", requestId: "stub-req", ...extra });

export const ASSIST_META = "We help hotels and villas in Bali rank for local searches and win more direct bookings without paying any agent commission.";

const KINDS = ["outline", "meta_description", "faq", "translate_draft", "alt_text"];

function suggestionsFor(kind) {
  switch (kind) {
    case "meta_description": return [{ id: "s1", target: "/seo/description", text: ASSIST_META, length: ASSIST_META.length }];
    case "outline": return [{ id: "s1", target: null, headings: [{ level: 2, text: "Why local SEO matters" }, { level: 3, text: "Google Business Profile" }], markdown: "## Why local SEO matters\n\n### Google Business Profile" }];
    case "faq": return [
      { id: "s1", target: null, question: "What is local SEO?", answer: "It is how a business shows up in searches made near it." },
      { id: "s2", target: null, question: "How long does it take?", answer: "Most sites see movement within a few months of steady work." },
    ];
    case "translate_draft": return [{ id: "s1", target: null, sourcePath: "/blocks/0/props/h1", field: "h1", locale: "id", text: "SEO Lokal Bali", status: "first_draft_needs_human", notice: "First draft — needs a human" }];
    case "alt_text": return [{ id: "s1", target: "/blocks/0/props/body", index: 0, imageRef: "/img/team.jpg", alt: "The team at their desks" }];
    default: return [];
  }
}

const state = (S) => (S.assist ??= { calls: [], writes: [] });

/** Start the ledger from nothing. `server.mjs` calls it right after seeding: the seed writes items through the same handlers. */
export function resetAssist(S) {
  S.assist = { calls: [], writes: [] };
}

/** Count every write that reaches the stub other than assist itself. Called by `handleWebdesk` for each non-GET site route. */
export function noteWrite(S, method, rest) {
  if (method === "GET" || /\/assist$/.test(rest)) return;
  state(S).writes.push(`${method} ${rest}`);
}

/** POST …/items/:itemId/assist. Returns null for any other route. `S.items` is `wd.mjs`'s item store. */
export function handleAssist(S, { method, rest, body }) {
  const m = rest.match(/^\/items\/([^/]+)\/assist$/);
  if (!m || method !== "POST") return null;
  const it = S.items.get(m[1]);
  if (!it) return problem(404, "item-not-found", "Item not found");
  // strict body, as the real route: `kind` is required, `version` optional, anything else is a 400
  const extra = Object.keys(body ?? {}).filter((k) => k !== "kind" && k !== "version");
  if (!body || !KINDS.includes(body.kind) || extra.length) return problem(400, "invalid_request", "Invalid request", "kind must be one of the assist kinds");
  if (it.deletedAt) return problem(409, "item-deleted", "Item deleted", "This item has been deleted.");

  const st = state(S);
  st.calls.push({ itemId: it.itemId, kind: body.kind, version: body.version ?? null });

  if (S.cfg.assistRefuse) {
    const which = S.cfg.assistRefuse; S.cfg.assistRefuse = null;
    if (which === "budget") return problem(429, "assist-budget-exceeded", "Daily AI assist budget used up", "You have used today's AI suggestions.", { scope: "principal", limits: { calls: 40, tokens: 120000 }, used: { calls: 40, tokensEstimated: 1000 }, retryAfterSeconds: 7200 });
    if (which === "unavailable") return problem(503, "assist-unavailable", "AI assist is unavailable", "The AI service could not answer.", { reason: "gateway_unavailable" });
    if (which === "not-applicable") return problem(422, "assist-not-applicable", "Nothing to suggest from", "This item does not have what this kind needs.", { reason: "not_enough_text", kind: body.kind });
    if (which === "output-invalid") return problem(502, "assist-output-invalid", "The suggestion was not usable", "The AI answered, but not in a usable form.", { reason: "not_json", kind: body.kind });
    if (which === "deleted") return problem(409, "item-deleted", "Item deleted", "This item has been deleted.");
  }

  const headN = it.versions[it.versions.length - 1].n;
  return R(200, {
    kind: body.kind, itemId: it.itemId, version: body.version ?? headN, headVersion: headN, locale: it.locale, advisory: true,
    suggestions: suggestionsFor(body.kind),
    ...(body.kind === "translate_draft" ? { notice: "First draft — needs a human" } : {}),
    provider: "stub-provider",
    usage: { callsUsed: st.calls.length, callsLimit: 40, tokensEstimatedUsed: st.calls.length * 600, tokensLimit: 120000, tokensAreEstimates: true, scope: "principal", automated: false },
  });
}

/** For `/__stub/state`: what the spec asserts on. */
export function assistSnapshot(S) {
  const st = state(S);
  return { calls: st.calls.map((c) => ({ ...c })), writes: [...st.writes] };
}
