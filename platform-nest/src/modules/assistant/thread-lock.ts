// The assistant thread's own per-thread serialization lock — extracted out of
// `assistant.controller.ts` (where it was originally private, ASST-06) so a SECOND caller
// (`handoffs.ts`'s handoff-suspension harvest, closing the confirm-chip bypass — see that file's
// header) can take the SAME lock without creating an import cycle between the controller and
// `handoffs.ts` (the controller already imports FROM `handoffs.ts`).
//
// Same `pg_advisory_xact_lock(NS, hashtext(id))` idiom as `core/pipeline-lock.ts` (WD-29/DEF-2):
// xact-scoped, released on COMMIT/ROLLBACK, meaningful ONLY inside a real transaction
// (`withTenants` wraps its callback in BEGIN/COMMIT — see that file's own header for why an
// autocommit connection would make this a silent no-op).
//
// WHY BOTH `sendMessage` AND THE HANDOFF HARVEST MUST SHARE THIS ONE NAMESPACE+FUNCTION: both
// paths can allocate the NEXT `seq` for the same thread's `assistant_messages` (`sendMessage`'s
// user+placeholder pair; the harvest's synthesized "here's a drafted write" message) via the same
// `COALESCE(MAX(seq),0)+1` read-then-write. Two different lock namespaces (or two copies of this
// function that drift) would let those two paths race past each other and collide on
// `UNIQUE (thread_id, seq)` — a 500, not a silent bug, but still a needless one when one shared
// lock removes the race entirely.
import type { PoolClient } from "pg";

/** Advisory-lock namespace (int4) for assistant-thread serialization: 'AST' + 1, distinct from
 *  every other lock namespace in the app (PIPELINE_RUN_LOCK_NS, the search module's two). */
export const ASSISTANT_THREAD_LOCK_NS = 0x41535401;

/** Serialize a state transition for ONE assistant thread. Call as the FIRST statement inside the
 *  `withTenants` callback, before any read whose result the handler then acts on. */
export async function lockAssistantThread(c: PoolClient, threadId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ASSISTANT_THREAD_LOCK_NS, threadId]);
}
