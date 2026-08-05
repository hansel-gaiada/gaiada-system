import "server-only";
// ASST-07 — the server-only half of the assistant's SSE stream, mirroring
// `portal-stream-server.ts` almost exactly (same header explains why this exists at all: EventSource/
// fetch-streaming is a BROWSER capability, and the browser can never hold the platform's bearer
// token, so a route handler has to sit in between). Two differences from the portal's version:
//
//   1. This one takes `messageId` (the pending-placeholder id from `sendMessageAction`'s response)
//      as well as `threadId` — the backend's stream route requires it (`?messageId=<id>`).
//   2. DEMO_MODE doesn't fall back to "no stream" here the way the portal's live-notifications proxy
//      does (that one degrades to polling, which is fine for a "nice to have" realtime indicator).
//      The assistant's stream IS the feature — "tokens render incrementally" is this ticket's core
//      acceptance criterion — so DEMO_MODE instead answers with a REAL synthetic SSE stream built by
//      `lib/demoAssistant.ts`, in the exact wire format the live backend uses, so the whole flow is
//      drivable with zero backend running.
import { demoAssistantStreamBody } from "./demoAssistant";

export type AssistantStreamUpstream =
  | { kind: "stream"; body: ReadableStream<Uint8Array> }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function assistantStreamUpstream(
  tenant: string,
  threadId: string,
  messageId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<AssistantStreamUpstream> {
  if (process.env.DEMO_MODE === "1") {
    const body = demoAssistantStreamBody(tenant, threadId, messageId);
    return body ? { kind: "stream", body } : { kind: "not_found" };
  }

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
    const res = await fetch(
      `${base}/api/${tenant}/assistant/threads/${threadId}/stream?messageId=${encodeURIComponent(messageId)}`,
      { headers: { ...authHeaders, accept: "text/event-stream" }, cache: "no-store", signal },
    );
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok || !res.body) return { kind: "unavailable" };
    return { kind: "stream", body: res.body };
  } catch {
    return { kind: "unavailable" };
  }
}
