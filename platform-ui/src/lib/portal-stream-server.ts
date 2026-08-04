import "server-only";
// CP-5 — the ONE raw `fetch` to the platform that is not `platformFetch`, and the reason it exists.
//
// `platformFetch` parses the response as JSON (`await res.json()`). An SSE response never completes, so
// calling it here would hang until the stream ended and then fail. This helper therefore duplicates
// exactly one thing from that module — its AUTH RESOLUTION ORDER — and nothing else: OIDC session token
// first, dev service-token + `x-user-id` second, same env vars, same precedence. If that order ever
// changes in `platform.ts`, it must change here too; there is no way to share it without either
// exporting the header builder or making `platformFetch` stream-aware, and a 12-line duplicate with
// this comment on it was judged the smaller liability.
//
// Everything else about the stream — framing, heartbeats, filtering — belongs to the backend and to the
// route handler that pipes it.

/** Open the upstream SSE response, or `null` if the platform cannot be reached / refuses.
 *
 *  `signal` is the incoming request's AbortSignal: when the browser closes the EventSource, Next aborts
 *  the request, and passing it through is what tears down the upstream connection too. Without it the
 *  platform would keep an open SSE connection (and its subscriber, and its heartbeat timer) per
 *  abandoned browser tab, which is a slow leak that only shows up under real traffic. */
export async function portalStreamUpstream(
  tenant: string,
  userId: string,
  signal?: AbortSignal,
): Promise<Response | null> {
  // DEMO_MODE has no backend at all. Returning null makes the route answer its poll-mode hello frame,
  // so the whole portal is browsable — and the POLLING fallback is what gets exercised in demo mode and
  // in the e2e suite, which is the path most likely to break unnoticed.
  if (process.env.DEMO_MODE === "1") return null;

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  let authHeaders: Record<string, string>;
  let accessToken: string | null = null;
  try {
    const { getSession } = await import("./session-server");
    const s = await getSession();
    if (s?.mode === "oidc") accessToken = s.accessToken;
  } catch {
    accessToken = null;
  }
  if (accessToken) {
    authHeaders = { authorization: `Bearer ${accessToken}` };
  } else {
    authHeaders = { authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}`, "x-user-id": userId };
  }

  try {
    const res = await fetch(`${base}/api/${tenant}/portal/stream`, {
      headers: { ...authHeaders, accept: "text/event-stream" },
      cache: "no-store",
      signal,
      // Node's undici buffers a response body by default only when it is consumed as text; returning
      // `res.body` streams it. No `duplex` needed — this is a GET with no request body.
    });
    // A non-2xx upstream (403 for a non-client, 401 for a stale token) is reported as "no stream" so the
    // client polls instead of retrying a request that will keep failing for the same reason.
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}
