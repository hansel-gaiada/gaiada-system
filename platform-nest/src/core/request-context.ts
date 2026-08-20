import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

// ── THE REQUEST'S CO-AUTHOR, carried ambiently (2026-08-20) ──────────────────────────────────────
//
// [agent-attribution-gate], interim half. Every `activities` row recorded "Alice did X" when the truth
// was "Alice's agent did X", because `Principal` had no channel field and so the information had
// nowhere to live. `Principal.via` now carries it — but `writeActivity` has **263 call sites**, 229 of
// which pass `req.principal.userId` and nothing else.
//
// ── WHY AsyncLocalStorage AND NOT A SEVENTH PARAMETER ────────────────────────────────────────────
// Threading `via` explicitly would be ~229 mechanical edits across every module, and — worse — it would
// make attribution OPT-IN. The failure mode of an opt-in audit field is that the one call site somebody
// forgets is the one that mattered, and nothing fails when they forget. Ambient context inverts that:
// the write is attributed unless something actively strips it.
//
// This is an established idiom in this codebase, not a new one:
// `src/modules/search/providers/types.ts`'s `withActualCostCapture` uses ALS for the same reason (its
// header explains why ALS rather than an instance field — parallel in-flight operations would share
// one field and clobber each other; the same is true of concurrent requests here).
//
// ── WHY THE STORE IS A MUTABLE BOX ───────────────────────────────────────────────────────────────
// The hook must wrap the WHOLE request continuation, so it runs at `onRequest` — before the AuthGuard
// has resolved anything. The guard then fills the box in. `als.run(store, done)` propagates through the
// rest of the Fastify lifecycle (this is the same mechanism `@fastify/request-context` uses), so a
// handler and everything it awaits sees the box the guard wrote to.
//
// ── FAIL-SILENT BY DESIGN ────────────────────────────────────────────────────────────────────────
// No store (a background job, a consumer loop, a unit test calling `writeActivity` directly) ⇒
// `currentVia()` is undefined ⇒ the row is written exactly as it was before this file existed. An
// attribution mechanism must never be able to break a write; the worst it may do is add nothing.

export interface RequestVia {
  provider: string;
  externalId: string;
  /** Present only when an AGENT drove the request — its absence means a human did. */
  agent?: string;
}

interface RequestStore {
  via?: RequestVia;
}

const als = new AsyncLocalStorage<RequestStore>();

/** Run `fn` inside a fresh request scope. Exported for tests and for any non-HTTP entry point that
 *  wants its writes attributed (a consumer handling an agent-origin event, say). */
export function runWithRequestContext<T>(fn: () => T, initial: RequestStore = {}): T {
  return als.run(initial, fn);
}

/** Record the channel for the current request. Called by the AuthGuard once it knows. No-op outside a
 *  request scope, so a unit test that exercises the guard directly does not need the plumbing. */
export function setRequestVia(via: RequestVia): void {
  const store = als.getStore();
  if (store) store.via = via;
}

/** The current request's channel, or undefined. */
export function currentVia(): RequestVia | undefined {
  return als.getStore()?.via;
}

/**
 * Wrap every request in a context box. Registered from `main.ts` alongside the other Fastify hook
 * (`registerInboundRawBodyCapture`), and deliberately at `onRequest` — the earliest hook — so nothing
 * in the lifecycle runs outside the scope.
 */
export function registerRequestContext(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", (_req, _reply, done) => {
    als.run({}, done);
  });
}
