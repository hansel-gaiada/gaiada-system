import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReportAccessDenied } from "@/components/reports/ReportAccessDenied";
import type { GroupLoad } from "./loadGroup";

// The three ways a Group page can have nothing to draw. Each keeps the page's single h1, so a
// refusal is still a page, never a bare error. The text states what the page needs and what to do,
// because "no access" with no next step reads as a bug.
export function GroupNotice({ title, load }: { title: string; load: Exclude<GroupLoad, { kind: "ok" }> }) {
  return (
    <>
      <PageHeader eyebrow="Group" title={title} />
      {load.kind === "no_company" && <EmptyNote>Select a company from the top bar.</EmptyNote>}
      {load.kind === "not_root" && (
        <ReportAccessDenied
          reason={`The group report lives on the group's root company; switch to it. ${load.active.name} is not a root company, so there is no group to report on from here.`}
        />
      )}
      {load.kind === "forbidden" && (
        <ReportAccessDenied reason="Group reports are limited to the owner of the group's root company and platform administrators." />
      )}
    </>
  );
}
