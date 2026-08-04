import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { portalStreamUpstream } from "@/lib/portal-stream-server";

// CP-5 — the browser's only route to the portal's SSE stream.
//
// WHY A PROXY EXISTS AT ALL, given this repo's rule that pages call `platformFetch` directly and do not
// route through their own API: EventSource is a BROWSER API. The browser cannot call the platform,
// because the platform needs an Authorization header and the whole design of `lib/platform.ts` is that
// the token never leaves the server. So this is one of the enumerated exceptions in platform-ui's
// CLAUDE.md — "route handlers exist only where the browser itself must hit a URL" — alongside the
// meetings status poll and the OAuth callback.
//
// It is a PIPE, not a handler: the upstream body is returned untransformed. No parsing, no buffering, no
// re-framing. That matters because SSE framing is whitespace-significant (`\n\n` terminates an event)
// and because anything this file understood about the frames would be a second place to keep in sync
// with the backend.
//
// `force-dynamic` + `revalidate = 0`: without them Next can treat a GET route handler as static at
// build time, which for a stream means the build hangs trying to collect a response that never ends.
export const dynamic = "force-dynamic";
export const revalidate = 0;
// The Node runtime, not edge: `lib/session-server` reads an HMAC cookie via node:crypto.
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const userId = await getSessionUserId();
  // 401 rather than a redirect: an EventSource follows redirects and would end up parsing the login
  // PAGE as an event stream, which fails silently and reconnects forever.
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let tenant: string | null = null;
  try {
    const me = await getMe(userId);
    tenant = await getActiveTenant(me);
  } catch {
    tenant = null;
  }
  if (!tenant) return NextResponse.json({ error: "no workspace" }, { status: 400 });

  const upstream = await portalStreamUpstream(tenant, userId, req.signal);
  if (!upstream) {
    // The platform is unreachable or refused. Answering with a single well-formed `hello` frame in
    // poll mode — rather than an error status — is deliberate: the client then knows to poll, and does
    // NOT enter EventSource's automatic reconnect loop against a backend that is down. A 502 here
    // would produce a retry every few seconds from every open portal tab for the whole outage.
    return new Response(
      `retry: 30000\nevent: hello\ndata: ${JSON.stringify({ mode: "poll", reason: "upstream_unavailable" })}\n\n`,
      { status: 200, headers: sseHeaders() },
    );
  }
  if (!upstream.body) return NextResponse.json({ error: "no stream" }, { status: 502 });

  return new Response(upstream.body, { status: 200, headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    // `no-transform` as well as `no-cache`: a compressing proxy re-introduces the buffering that
    // `x-accel-buffering` is here to prevent.
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}
