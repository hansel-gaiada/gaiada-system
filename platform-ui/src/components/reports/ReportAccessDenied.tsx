import { Card } from "@/components/ui";

// The rollups 403-branch precedent (`app/(app)/rollups/page.tsx`), shared across all four grain
// pages: an unauthorized read is 403, never 404 (§8 hard rule 2), so the UI renders a limited-access
// state, never a crash and never a generic error page. `reason` names the actual §8 boundary that
// applies to the grain being viewed, so the message is specific rather than a bare "no access".
export function ReportAccessDenied({ reason }: { reason: string }) {
  return (
    <Card>
      <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>{reason}</p>
    </Card>
  );
}
