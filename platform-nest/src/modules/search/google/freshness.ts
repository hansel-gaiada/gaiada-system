// SM-25b — the freshness-lag clamp shared by google/gsc-client.ts and google/ga4-client.ts (design
// addendum §A12; tracker §6x.3 item 5's "GSC's data-freshness lag" clause).
//
// ── THE PROBLEM THIS EXISTS TO FORECLOSE ──────────────────────────────────────────────────────────
// Search Console (documented: 2-3 days) and, to a lesser extent, GA4 (documented: intraday data is
// provisional and can still change for roughly a day) both report INCOMPLETE data for the most recent
// day(s) — not zero, not absent, but genuinely partial. A pull that requests "today" or "yesterday"
// and persists whatever comes back would write a real, low, misleading number: on the next pull for
// the SAME day, the (now-settled) real figure replaces it — via the idempotent UPSERT (0061) — and a
// reader watching the raw history would see what LOOKS exactly like a genuine traffic/rank collapse
// followed by a recovery. That is precisely the "a partial day must not read as a drop to zero" defect
// the ticket names.
//
// ── THE FIX: NEVER REQUEST INSIDE THE LAG WINDOW, RATHER THAN FLAG A PARTIAL ROW ──────────────────
// Two ways to solve this were available: (a) fetch the recent days anyway and mark them "partial", or
// (b) never fetch them in the first place. (a) requires a schema column (0061 deliberately has none —
// see its file header) and a discipline every future reader must remember to check; (b) makes the
// partial row NEVER EXIST, so there is nothing for a reader to mis-render. This module takes (b): a
// requested end date more recent than `today - lagDays` is CLAMPED to the boundary, and the clamp is
// DISCLOSED in the caller's outcome (never silently substituted) so a caller who explicitly asked for
// "through today" can see exactly what was actually fetched instead.
//
// ── WHY A SHARED PURE FUNCTION RATHER THAN TWO COPIES ─────────────────────────────────────────────
// GSC and GA4 have DIFFERENT documented lag facts (§A7-style: owner/vendor-doc facts, not measured
// against real Google — SM-41G confirms or corrects them), so each client passes its OWN `lagDays`;
// what is shared is the clamp ARITHMETIC and the disclosure shape, so the two ingestion paths cannot
// silently drift into different clamp semantics while still allowing different lag CONSTANTS.
//
// ── SM-64 AMENDMENT — THE CLAMP ALONE ONLY COVERS THE OUTBOUND HALF ───────────────────────────────
// Everything above narrows the REQUEST. It says nothing about the RESPONSE: `clampEndDateToFreshnessLag`
// guarantees Google is never ASKED for a date inside the lag window, but the "no partial row anywhere
// to mislabel" guarantee this file's header used to claim unconditionally is actually conditional on
// Google (or GA4) HONOURING that request — a vendor-trust assumption, not a proof. A sandbox that does
// not itself enforce date-range filtering (or a real vendor date-filtering bug, or a clock-skewed
// "today" on either side of the request) can hand back a row dated inside the window regardless of what
// was asked. §A14 (echo-validation, design addendum) rules that any outbound constraint must be
// re-verified on the response before persistence — `isRowDateWithinWindow` below is that re-verification
// for the date-window constraint specifically, living beside the clamp for the identical "shared
// arithmetic, per-client constants" reason: GSC and GA4 both call it with their OWN `startDate` and
// `effectiveEndDate`, so the two ingestion paths cannot drift into different window semantics either.
// A row failing this check is SKIPPED before the UPSERT and counted (`rowsOutsideRangeSkipped`), never
// silently absorbed and never flagged in place (flagging was foreclosed — see the ticket/addendum: it
// reopens the 0061-refused schema column and creates a second partial-data state a reader must
// remember to check). The loss is bounded deferral, not destruction: the idempotent UPSERT re-fetches
// that date once it has left the lag window on a later pull.

/** ISO 'YYYY-MM-DD' for `daysAgo` days before `now` (UTC-based — Google's own date dimension is a
 *  calendar date with no per-property timezone offset applied here; property-timezone-aware clamping
 *  is an SM-41G-observable refinement, not something a local harness can validate against real Google
 *  account timezone settings). */
export function isoDateDaysAgo(daysAgo: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export interface FreshnessClamp {
  /** What the caller asked for (or the lag boundary, when the caller specified nothing). */
  requestedEndDate: string;
  /** What was ACTUALLY requested from Google — never later than `today - lagDays`. */
  effectiveEndDate: string;
  /** True when `effectiveEndDate` differs from `requestedEndDate` — i.e. the caller's request reached
   *  into the lag window and was pulled back. False is the honest, common case: most callers do not
   *  ask for "today" at all. */
  clamped: boolean;
  lagDays: number;
}

/** Clamp an end date to the freshness-lag boundary. `requestedEndDate` is optional — omitting it means
 *  "as much as is safe to fetch", i.e. exactly the boundary itself, with `clamped: false` (there was no
 *  narrower request to have honoured; the boundary IS the request). Passing an end date already at or
 *  before the boundary is a no-op (`clamped: false`) — clamping only ever moves a date EARLIER, never
 *  later, so it can only narrow a request, never widen one past what was asked for. */
export function clampEndDateToFreshnessLag(
  requestedEndDate: string | undefined,
  lagDays: number,
  now: Date = new Date(),
): FreshnessClamp {
  const boundary = isoDateDaysAgo(lagDays, now);
  const requested = requestedEndDate ?? boundary;
  const effective = requested > boundary ? boundary : requested;
  return {
    requestedEndDate: requested,
    effectiveEndDate: effective,
    clamped: effective !== requested,
    lagDays,
  };
}

/** SM-64 — the response-side half of the freshness guarantee (§A14 echo-validation). True iff a
 *  RETURNED row's own `date` falls within the range actually requested — `[startDate, effectiveEndDate]`
 *  inclusive, the SAME `effectiveEndDate` the clamp above computed (never the raw, unclamped
 *  `requestedEndDate` — a row must honour what was ACTUALLY asked, not what a caller merely wished for).
 *  Plain ISO string comparison is safe and total here because both the row date and the bounds are
 *  always `YYYY-MM-DD` (GA4's caller normalizes `YYYYMMDD → ISO` BEFORE calling this — see ga4-client.ts
 *  — precisely so this predicate never has to know about either vendor's wire format).
 *
 *  A useful side effect, recorded rather than relied upon: because this is a plain string comparison
 *  against a fixed-width `YYYY-MM-DD` shape, a row whose date arrives as something else entirely (a
 *  stray query string, a `2026/07/30`-shaped value from a positional mix-up in slot 0) also fails this
 *  bound and lands in the same skip-and-count path — a free positional-integrity tripwire, not the
 *  purpose of this function but a fact worth knowing when reading `rowsOutsideRangeSkipped` counts. */
export function isRowDateWithinWindow(date: string, startDate: string, effectiveEndDate: string): boolean {
  return date >= startDate && date <= effectiveEndDate;
}
