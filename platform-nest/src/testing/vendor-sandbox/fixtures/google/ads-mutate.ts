// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// Google Ads API mutate response envelope: `{results: [{resourceName}], partialFailureError?}`.
//
// WHY THIS EXISTS IN SM-51 AND IS UNUSED BY SM-25a: the SM-51 spec calls for "Ads read + mutate
// envelopes" so that SM-26's executor CODE can be built against a fixture once SM-21 + SM-25c land
// (tracker §6x.3 item 5). NOTHING in SM-25a calls it, and nothing should: every Google Ads WRITE is
// governed by SM-21's approve-execute-replay + WS4 one-shot approval regardless of transport
// (§A12.1/D-8), and api-client.ts REFUSES a mutate-shaped path outright rather than leaving that to
// convention. Serving the envelope here does not open the write path; it only means SM-26 will not have
// to invent a shape.
//
// `partialFailureError` is the field that makes Ads mutations genuinely different from the read path: a
// 200 response can contain per-operation failures, so "HTTP 2xx" is NOT "the change was applied". Any
// executor must read it. Whether its shape matches this model is an SM-41G fact.
export function adsMutateBody(args: { resourceNames: string[]; partialFailure?: { code: number; message: string } | null }) {
  return {
    results: args.resourceNames.map((resourceName) => ({ resourceName })),
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
