"use client";
import { usePathname } from "next/navigation";
import { showMeStrip } from "@/lib/meTabs";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs, type SectionTab } from "./SectionTabs";

// Me's title and strip (DW-8d): the registry's Me row tabs, drawn only on Me's own pages. The layout sits above
// `/me/inbox`, `/me/tasks` and `/me/learning` too, which are not Me tabs and carry their own titles; there it
// renders nothing, so no page shows two titles. "Summary" is active only on exactly `/me` (SectionTabs takes the
// deepest matching href).
export function MeTabs({ tabs }: { tabs: SectionTab[] }) {
  const pathname = usePathname();
  if (!showMeStrip(pathname, tabs)) return null;
  return (
    <>
      <PageHeader eyebrow="You" title="Me" subtitle="Your leave, loans, pay, timesheet and account." />
      <SectionTabs tabs={tabs} />
    </>
  );
}
