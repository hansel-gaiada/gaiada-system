import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotSkills, type BotSkill } from "@/lib/admin";

// Read for the Controls tab's "Bot capabilities" panel — the skills catalog
// (command prefix, mention trigger, and each command's name/description) so
// an operator can see what the bot answers without reading source. Read-only,
// no state of its own; mirrors the other Controls-tab proxy routes' fail-soft
// shape.
export const dynamic = "force-dynamic";

interface SkillsPoll {
  commandPrefix: string | null;
  botMention: string | null;
  skills: BotSkill[] | null;
  error?: string;
}

function json(body: SkillsPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return json({ commandPrefix: null, botMention: null, skills: null, error: "Session expired — sign in again." }, 401);
  }

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json(
      { commandPrefix: null, botMention: null, skills: null, error: "Bot capabilities are limited to superadmins/owners." },
      403,
    );
  }

  try {
    const snapshot = await getBotSkills(userId);
    return json({
      commandPrefix: snapshot?.commandPrefix ?? "",
      botMention: snapshot?.botMention ?? "",
      skills: snapshot?.skills ?? [],
    });
  } catch (e) {
    return json({
      commandPrefix: null,
      botMention: null,
      skills: null,
      error: e instanceof PlatformError ? e.message : "bot admin unreachable",
    });
  }
}
