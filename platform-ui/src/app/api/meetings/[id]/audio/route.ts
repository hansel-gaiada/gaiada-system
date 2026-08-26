import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getRecording } from "@/lib/meetings";

// Streaming upload proxy for a recording's media (PRD Studio "Upload a file").
//
// Why a route handler and not a server action: a Server Action buffers the whole body on this
// server and is capped (1 MB by default — a 200 MB video died with "Body exceeded 1 MB limit"), and
// the browser gets no progress events from it. Here the browser POSTs the multipart body itself
// (XMLHttpRequest, so it can show progress) and this handler forwards the body as a STREAM to the
// platform — same content-type (boundary intact), same length, auth added server-side. Nothing is
// parsed or held here; the platform enforces the size/type caps and its 413/415 pass straight back.
// One of the few `app/api/*` handlers, for the reason platform-ui/CLAUDE.md allows them: the browser
// itself must hit a URL.
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Session expired — sign in again." }, { status: 401, headers: noStore });

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return NextResponse.json({ error: "No active company selected." }, { status: 404, headers: noStore });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "Expected a multipart/form-data upload with a `file` field." }, { status: 400, headers: noStore });
  }

  if (process.env.DEMO_MODE === "1") {
    // No platform to stream to: read the form once (demo files are tiny) and update the demo store
    // the same way uploadAudioAction does, so the card's transcribing→transcribed poll is drivable.
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose an audio or video file first." }, { status: 400, headers: noStore });
    const { demoUploadAudio } = await import("@/lib/demoMeetings");
    const r = demoUploadAudio(id, file.name, file.size);
    return NextResponse.json(r.json, { status: r.status, headers: noStore });
  }

  // Preflight BEFORE streaming. The platform authorizes and looks up the recording before it reads
  // the body, so a 401/403/404 arrives while a 170 MB body is still in flight; Node then closes the
  // socket and the upload surfaces as a connection error with the real status lost. A cheap read of
  // the same row first turns those into the messages they are.
  const pre = await getRecording(userId, tenant, id);
  if (pre.kind === "forbidden") return NextResponse.json({ error: "You don't have permission to add a recording to this briefing." }, { status: 403, headers: noStore });
  if (pre.kind === "unavailable") return NextResponse.json({ error: "The platform is not answering right now — try again in a moment.", reason: pre.reason }, { status: 503, headers: noStore });
  if (!pre.data) return NextResponse.json({ error: "This briefing no longer exists." }, { status: 404, headers: noStore });

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  // Content-type (with its multipart boundary) is forwarded; content-length deliberately is NOT.
  // Forwarding it made undici police the byte count of the streamed body and a 170 MB upload died
  // with UND_ERR_REQ_CONTENT_LENGTH_MISMATCH. Without it the hop is chunked, which @fastify/multipart
  // (busboy) reads exactly the same way, and the platform's own size caps still apply.
  const headers: Record<string, string> = { ...(await platformAuthHeaders(userId)), "content-type": contentType };

  let upstream: Response;
  try {
    // `duplex: "half"` is what undici requires to send a ReadableStream body.
    upstream = await fetch(`${base}/api/${tenant}/meetings/recordings/${encodeURIComponent(id)}/audio`, {
      method: "POST",
      headers,
      body: req.body,
      cache: "no-store",
      // @ts-expect-error — `duplex` is not in the DOM RequestInit type yet, but undici needs it for streamed bodies.
      duplex: "half",
    });
  } catch (e) {
    // Say WHAT failed — "could not be reached" hid a real cause once (a 170 MB upload). undici puts the
    // socket-level reason on `cause`.
    const err = e as { message?: string; cause?: { code?: string; message?: string } };
    const reason = err.cause?.code ?? err.cause?.message ?? err.message ?? "unknown error";
    console.error("[meetings/audio] upstream fetch failed:", reason, err);
    return NextResponse.json({ error: `The platform could not be reached (${reason}) — try again in a moment.` }, { status: 502, headers: noStore });
  }

  // Pass the platform's answer through as-is (202 {status:"transcribing"} or its 4xx with a reason).
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { ...noStore, "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
