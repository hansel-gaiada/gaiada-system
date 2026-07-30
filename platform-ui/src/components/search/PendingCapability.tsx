import type { ReactNode } from "react";
import { Card } from "@/components/ui";
import { BackendPending } from "@/components/BackendPending";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import type { CostTier } from "@/lib/searchMarketing";

// A console tab whose SHAPE is decided but whose endpoints have not landed yet.
//
// SM-11 builds the whole IA at once so the department is navigable and reviewable
// end-to-end, but most Optimize/Campaigns tabs are owned by later tickets. The
// honest rendering for those is this: name the capability, show its cost tier,
// say plainly which endpoint is missing and which ticket owns it — never an empty
// table, which reads as "you have no data" when the truth is "this cannot have
// data yet". Each tab swaps this for its real body when its ticket lands.
export function PendingCapability({
  title,
  glyph,
  tier,
  summary,
  contract,
  owner,
  children,
}: {
  title: string;
  glyph: string;
  tier: CostTier;
  /** What this tab will do, in the operator's language. */
  summary: string;
  /** The exact missing endpoint(s), for whoever builds the backend. */
  contract: string;
  /** The ticket that owns it, so the reader can find the spec. */
  owner: string;
  children?: ReactNode;
}) {
  return (
    <Card title={title} headerRight={<CostTierBadge tier={tier} />}>
      <BackendPending what={`${summary} Owned by ${owner}.`} contract={contract} />
      <TeachState glyph={glyph} title={`${title} is not wired up yet`} body={`${owner} builds this surface. The route, permissions and cost tier are already in place, so it will light up here as soon as its endpoints land.`} />
      {children}
    </Card>
  );
}
