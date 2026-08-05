import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { assistantStreamUpstream } from "@/lib/assistant-stream-server";

// ASST-07 — the browser's only route to a thread's SSE stream. One of platform-ui's enumerated
// exceptions to "pages call platformFetch directly, don't proxy through our own API" (see CLAUDE.md):
// this is a URL the BROWSER itself has to fetch (a bearer token can never reach client JS), same
// reasoning as `/api/portal/stream`. Unlike that route, the client here uses plain `fetch` + a
// `ReadableStream` reader (not `EventSource`) — see `components/assistant/useAssistantStream.ts`'s
// header for why: it needs an `AbortController` for the 120s client idle timeout, and `EventSource`
// gives you no way to abort or to inspect a non-2xx response before it starts "streaming" garbage.
//
// The tenant is resolved SERVER-SIDE from the session cookie, never from anything the client sends —
// same defense-in-depth the portal proxy uses; the backend's owner-only Cerbos policy is the real
// boundary either way.
//
// `force-dynamic` + `revalidate = 0` + Node runtime: identical reasoning to the portal route (a
// GET route handler that never resolves must not be treated as staticizable at build time; the
// session cookie needs `node:crypto`).
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id: threadId } = await params;
  const messageId = new URL(req.url).searchParams.get("messageId");

  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (!messageId) return NextResponse.json({ error: "messageId is required" }, { status: 400 });

  let tenant: string | null = null;
  try {
    const me = await getMe(userId);
    tenant = await getActiveTenant(me);
  } catch {
    tenant = null;
  }
  if (!tenant) return NextResponse.json({ error: "no workspace" }, { status: 400 });

  const upstream = await assistantStreamUpstream(tenant, threadId, messageId, userId, req.signal);
  if (upstream.kind === "not_found") {
    return NextResponse.json({ error: "no pending generation for this messageId (already completed, stopped, or unknown)" }, { status: 404 });
  }
  if (upstream.kind === "unavailable") {
    // The platform is unreachable. Unlike the portal's live-notifications proxy, there is no sane
    // "poll instead" degrade for a chat reply — surface it as a real failure so the client's stream
    // consumer renders an error bubble instead of hanging.
    return NextResponse.json({ error: "assistant backend unavailable" }, { status: 502 });
  }

  return new Response(upstream.body, { status: 200, headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}
