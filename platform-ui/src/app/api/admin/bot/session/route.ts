import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";

// Poll read for the Connect WhatsApp surface (A5, doc §2.5). The browser
// polls this every 3s while a session is mid-pairing. Server-side
// platformFetch only — the bot admin token never reaches the client, and the
// nest proxy itself re-enforces `isElevated` on every `api/admin/bot/*` route
// (doc §2.4) and fails soft (502/404) when the bot admin proxy is
// unreachable/unconfigured. This route mirrors that fail-soft contract rather
// than fabricating a status.
//
// QR is a pairing secret (doc §4): never cached (`Cache-Control: no-store`
// end-to-end), never logged, and forwarded through byte-for-byte from the
// nest proxy — this route holds no state of its own.
export const dynamic = "force-dynamic";

export interface BotSessionInfo {
  session: string;
  status: string;
  engine?: string;
  me?: { id: string; pushName?: string } | null;
  lastEvent?: { status: string; ts: number } | null;
}

export interface BotSessionPoll {
  status: BotSessionInfo | null;
  qr: string | null;
  error?: string;
}

const PAIRING_STATUSES = new Set(["STARTING", "SCAN_QR_CODE"]);

function json(body: BotSessionPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return json({ status: null, qr: null, error: "Session expired — sign in again." }, 401);

  // Cosmetic gate (defense-in-depth, mirrors lib/billingActions.ts's ctx()) —
  // the real boundary is nest's own isElevated check on api/admin/bot/*.
  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json(
      { status: null, qr: null, error: "WhatsApp connection controls are limited to superadmins/owners." },
      403,
    );
  }

  let status: BotSessionInfo | null = null;
  let error: string | undefined;
  try {
    status = await platformFetch<BotSessionInfo>("/api/admin/bot/session/status", userId);
  } catch (e) {
    error = e instanceof PlatformError ? e.message : "bot admin unreachable";
  }

  // Only worth the second hop when a QR could actually be pending — nest/bot
  // degrade to {qr:null} anyway for every other status (doc §2.1), but
  // skipping the call once paired/stopped/failed keeps the 3s poll cheap.
  let qr: string | null = null;
  if (status && PAIRING_STATUSES.has(status.status)) {
    try {
      const q = await platformFetch<{ qr: string | null; status: string }>("/api/admin/bot/session/qr", userId);
      qr = q.qr;
    } catch {
      // non-fatal — leave qr null, status still renders.
    }
  }

  return json({ status, qr, error });
}
