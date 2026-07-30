import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";

// Mutation for the Controls tab's "Run now" digest buttons (ControlsTab.tsx).
// This posts REAL messages into REAL WhatsApp groups — the component disables
// the button while the request is in flight and never calls this
// optimistically.
//
// ASYNC contract: a real run takes ~90s (11 groups, each summarized through the AI gateway),
// which is why this used to 502 with "bot admin unreachable" even though the run had actually
// completed fine a bit later — a synchronous HTTP round-trip was the wrong shape for the job.
// The bot (and nest's proxy) now answer 202 the instant the run STARTS, never the instant it
// finishes; the digest-history table (GET /api/admin/bot/digests) is the only authoritative
// record of the outcome, and ControlsTab polls it after this resolves.
export const dynamic = "force-dynamic";

interface DigestRunResult {
  ok: boolean;
  started?: boolean;
  startedAt?: number;
  conflict?: boolean;
  error?: string;
}

function json(body: DigestRunResult, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const VALID_SLOTS = new Set(["noon", "evening"]);

export async function POST(_req: Request, { params }: { params: Promise<{ slot: string }> }) {
  const { slot } = await params;
  const userId = await getSessionUserId();
  if (!userId) return json({ ok: false, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ ok: false, error: "Manual digest runs are limited to superadmins/owners." }, 403);
  }

  if (!VALID_SLOTS.has(slot)) {
    return json({ ok: false, error: "slot must be noon or evening" }, 400);
  }

  try {
    const result = await platformFetch<{ started: boolean; slot: string; startedAt: number }>(
      `/api/admin/bot/digests/run/${slot}`,
      userId,
      { method: "POST" },
    );
    return json({ ok: true, started: true, startedAt: result.startedAt }, 202);
  } catch (e) {
    // The bot's own overlap guard — a run of this slot is already in flight. Not an error
    // exactly (the caller's intent — "run this slot" — is already happening), so it gets its
    // own flag rather than being lumped in with `error`.
    if (e instanceof PlatformError && e.status === 409) {
      return json({ ok: false, conflict: true, error: e.message || `A ${slot} digest run is already in progress.` }, 409);
    }
    if (e instanceof PlatformError && (e.status === 502 || e.status === 404)) {
      return json({ ok: false, error: "The bot isn't reachable right now — try again shortly." });
    }
    return json({ ok: false, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
