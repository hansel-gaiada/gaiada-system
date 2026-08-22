import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { globalSearch } from "@/lib/search";

// Command palette tier 3 — UI redesign §4.1/§4.2: the ONE tier that needs a network round-trip, so
// it goes through this browser-reachable route handler rather than `CommandPalette.tsx` (a client
// component) calling `platformFetch` directly — the single-egress rule.
//
// Deliberately NOT a new backend endpoint / BFF contract addition: this fans out to the SAME
// `globalSearch()` aggregator the existing `/search` page already calls (`lib/search.ts`, itself
// built on `lib/entities.ts`'s `listCompanies/listProjects/listTasks/listCampaigns/listMembers` —
// the exact readers those list pages use). §4.5's RBAC rule is satisfied by construction: a palette
// hit can never outrank what the record's own list page would already show, because it is the same
// read, not a second authorization surface to keep in sync. See docs/FRONTEND-BFF-CONTRACT.md §21.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const noStore = { "Cache-Control": "no-store" };
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ groups: [] }, { status: 401, headers: noStore });

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ groups: [] }, { status: 200, headers: noStore });

  const me = await getMe(userId).catch(() => null);
  if (!me) return NextResponse.json({ groups: [] }, { status: 401, headers: noStore });
  const tenant = await getActiveTenant(me);

  const groups = await globalSearch(userId, tenant, q).catch(() => []);
  // A keystroke-driven UI should not render a hundred rows — cap per group for responsiveness.
  const capped = groups.map((g) => ({ ...g, hits: g.hits.slice(0, 5) }));
  return NextResponse.json({ groups: capped }, { status: 200, headers: noStore });
}
