import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getRecording } from "@/lib/meetings";

// WD-07 (Part A, WD-04 frontend) — poll read for the in-ERP audio-upload progress affordance
// (`AudioUploadForm.tsx`). Same pattern as `/api/admin/bot/session` (WhatsAppConnect): the
// browser polls this every few seconds while status is `transcribing`, and the effect
// self-terminates the moment it flips to a terminal state (`transcribed`/`failed`). Server-side
// `getRecording` only — no new backend surface, no secret ever reaches the client.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Session expired — sign in again." }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return NextResponse.json({ error: "No active company selected." }, { status: 404, headers: { "Cache-Control": "no-store" } });

  // AGN-3: this route is polled by the client while a recording processes, so collapsing every
  // non-answer into 404 told the poller "it's gone" when the truth was "you may not read it" or "we
  // cannot tell" — and a poller that believes "gone" stops polling. Each outcome now gets its own
  // status, which is also what makes the refusal legible in the network tab.
  const recResult = await getRecording(userId, tenant, id);
  if (recResult.kind === "forbidden") {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (recResult.kind === "unavailable") {
    return NextResponse.json(
      { error: "recording status unavailable", reason: recResult.reason },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const rec = recResult.data;
  if (!rec) return NextResponse.json({ error: "recording not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

  return NextResponse.json(
    { id: rec.id, status: rec.status, audioRef: rec.audio_ref, hasTranscript: !!rec.transcript },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
