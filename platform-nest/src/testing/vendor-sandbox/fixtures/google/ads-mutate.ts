// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// Google Ads API mutate response envelope: `{results: [{resourceName}], partialFailureError?}`.
//
// WHY THIS EXISTS IN SM-51 AND WAS EXTENDED BY SM-26: the SM-51 spec calls for "Ads read + mutate
// envelopes" so that SM-26's executor CODE could be built against a fixture once SM-21 + SM-25c land
// (tracker §6x.3 item 5). SM-26 (tracker §6bp Ruling 6) is now that consumer, and it drives THREE
// distinct response shapes the original single-purpose helper did not distinguish:
//   1. the clean case — one result per operation, every one carrying a `resourceName`;
//   2. a PER-ROW failure INSIDE a correctly-sized response (`partialFailureError` present, and the
//      failed position's own result object carries NO `resourceName`) — Ruling 6.3's "per-row outcome,
//      not an addressing failure";
//   3. a genuinely wrong-shaped response (too few/too many results) — the count/shape mismatch that
//      impeaches the whole execution's addressing (Ruling 6.3, the other half).
// `resultsForPositions` lets a test construct exactly (1) or (2) by position; `google-server.ts`'s
// mutate handler itself is what can additionally produce (3), by echoing a genuinely wrong count.
export interface AdsMutateResultSpec {
  /** `null` ⇒ this position's result carries no `resourceName` (a per-row failure inside an otherwise
   *  correctly-sized response — Ruling 6.3's per-row outcome, never an addressing failure). */
  resourceName: string | null;
}

export function adsMutateBody(args: {
  results: AdsMutateResultSpec[];
  partialFailure?: { code: number; message: string } | null;
}) {
  return {
    results: args.results.map((r) => (r.resourceName ? { resourceName: r.resourceName } : {})),
    ...(args.partialFailure
      ? {
          partialFailureError: {
            code: args.partialFailure.code,
            message: args.partialFailure.message,
            details: [],
          },
        }
      : {}),
  };
}
