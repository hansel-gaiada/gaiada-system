import "server-only";
import { PlatformError } from "./platform";

/**
 * ── ONE SHAPE FOR "THE READ DID NOT RETURN DATA" ─────────────────────────────────────────────────
 *
 * Readiness-bar criterion 5: "Explicit refusal. Denials carry a structured reason. Never an empty
 * list that reads as 'no data'." Its stated failure signal is `403/404 collapsed into []`, and the
 * cost is already on the record — the client portal told staff "your kickoff is being processed"
 * when the read had in fact been refused.
 *
 * Three genuinely different answers were being flattened into one empty array:
 *
 *   ok          — the read succeeded. An empty `data` here is EVIDENCE of emptiness.
 *   forbidden   — the viewer may not see this. Something may well be here; they cannot be told.
 *   unavailable — nobody can tell right now. NOT a statement about contents in either direction.
 *
 * `absent` is deliberately NOT a variant. A 404 on a LIST route means the route or module is not
 * served here, which callers already handle by degrading; a 404 on a single ITEM is a real answer
 * ("no such row") and belongs in `ok` with a null payload, not in a refusal type. Adding a fourth
 * variant that half the call sites ignore would recreate the ambiguity this type exists to remove.
 *
 * WHY A SHARED TYPE AND NOT SIX PRIVATE ONES: six near-duplicate `safe()`/`skipMissing()` helpers
 * already drifted into four different rules (see `readerDegrade.test.ts`), because each was private
 * to its own module and nothing compared them. `it-accounts.ts` then hand-rolled this exact
 * discriminated shape correctly, and `webdevProvisionedSites-data.ts` hand-rolled its own variant of
 * it — two right answers, independently, with no shared vocabulary. This is that vocabulary; render
 * it with `<ReadRefusal>`.
 */
export type ReadResult<T> =
  | { kind: "ok"; data: T }
  /** 403 — the viewer may not read this. Never render as emptiness. */
  | { kind: "forbidden" }
  /** The read failed for a reason that is not a denial. Carries the backend's own words. */
  | { kind: "unavailable"; reason: string };

/**
 * Wrap a reader so a refusal becomes DATA the page can render, instead of an exception the page
 * crashes on or an empty array the page lies with.
 *
 * `absentAsEmpty` exists for LIST routes behind a module guard: a 404 there means "this company does
 * not have the module turned on", which is genuinely not a refusal and not an error — the caller
 * passes the empty value it wants to show. It is opt-in precisely so that no caller degrades a 404
 * without having thought about whether absence is a real answer for that route.
 */
export async function readResult<T>(p: Promise<T>, opts?: { absentAsEmpty?: T }): Promise<ReadResult<T>> {
  try {
    return { kind: "ok", data: await p };
  } catch (err) {
    if (err instanceof PlatformError) {
      if (err.status === 403) return { kind: "forbidden" };
      if ((err.status === 404 || err.status === 405) && opts && "absentAsEmpty" in opts) {
        return { kind: "ok", data: opts.absentAsEmpty as T };
      }
      return { kind: "unavailable", reason: err.message };
    }
    // A non-PlatformError is a timeout, a socket failure or a bug in the reader. Every one of those
    // is a "cannot tell", and none of them has an empty list as its correct rendering.
    return { kind: "unavailable", reason: (err as Error)?.message ?? "unknown error" };
  }
}
