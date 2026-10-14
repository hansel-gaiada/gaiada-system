"use client";
import { usePathname } from "next/navigation";
import { showMeStrip } from "@/lib/meTabs";
import { SectionTabs, type SectionTab } from "./SectionTabs";

// The `/me` strip (DW-8d): the registry's Me row tabs, drawn only on Me's own pages. The layout sits above
// `/me/inbox`, `/me/tasks` and `/me/learning` too, which are not Me tabs; there it renders nothing.
// "Summary" is active only on exactly `/me` (SectionTabs takes the deepest matching href).
export function MeTabs({ tabs }: { tabs: SectionTab[] }) {
  const pathname = usePathname();
  if (!showMeStrip(pathname, tabs)) return null;
  return <SectionTabs tabs={tabs} />;
}
