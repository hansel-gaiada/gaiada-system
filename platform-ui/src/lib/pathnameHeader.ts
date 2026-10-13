/** The request header `proxy.ts` sets to the request's pathname (no query), always overwriting a client-sent value.
 *  Read by `(app)/layout.tsx` (DW-3a2). Kept apart from proxy.ts so the layout does not import the proxy module. */
export const PATHNAME_HEADER = "x-gaiada-pathname";
