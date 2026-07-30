// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Semrush's confirmed "200 carrying an error" shape (semrush.ts's own file header): a failed lookup
// still returns HTTP 200 with a body of `ERROR <code> :: <message>`, checked by
// semrush.ts's assertNotErrorLine() on the FIRST line only. NOTHING_FOUND is the vendor-documented
// example; the invalid-key/missing-param lines are NOT vendor-confirmed codes (the docs pass did not
// surface Semrush's own auth-failure/param-validation error codes) — modeled here in the SAME shape
// so this sandbox's auth/strictness checks integrate with the driver's existing error-parsing path,
// not asserted as the vendor's real code numbers.
export const ERROR_LINE_NOTHING_FOUND = "ERROR 50 :: NOTHING FOUND";
export const ERROR_LINE_INVALID_KEY = "ERROR 121 :: INVALID API KEY (sandbox-modeled, not vendor-confirmed)";
export function errorLineMissingParam(param: string): string {
  return `ERROR 40 :: MISSING REQUIRED PARAMETER '${param}' (sandbox-modeled, not vendor-confirmed)`;
}
