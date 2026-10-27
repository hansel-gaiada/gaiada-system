/** The request header `proxy.ts` sets to the request's pathname (no query), always overwriting a client-sent value.
 *  Read by `(app)/layout.tsx` (DW-3a2). Kept apart from proxy.ts so the layout does not import the proxy module. */
export const PATHNAME_HEADER = "x-gaiada-pathname";

/** The request header `proxy.ts` sets to the request's query string (`?a=b`, or empty), on a document request only and always overwriting a client-sent
 *  value. With `PATHNAME_HEADER` it lets a layout that must send a signed-out visitor to /login keep the whole deep link, query included (SCP-2: the post
 *  link `/portal/social?post=<id>` that we send to a client). See `loginHrefForReturn` in `lib/returnTo.ts`. */
export const SEARCH_HEADER = "x-gaiada-search";
