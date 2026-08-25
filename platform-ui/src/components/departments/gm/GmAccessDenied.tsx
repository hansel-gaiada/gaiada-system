import { Card } from "@/components/ui";
import { GM_DENIED_REASON } from "@/lib/gm";

// The GM console's refusal state, shared by every GM tab.
//
// Deliberately the SAME shape as `/rollups`'s 403 branch and `ReportAccessDenied`: an unauthorized
// read renders a PAGE that names the boundary, never a 404 and never an empty grid. The standing
// ruling behind that: a UI-only gate that hides a surface the server would serve reads as broken
// rather than as forbidden, and an empty table reads as "no data" rather than "not yours".
//
// `reason` defaults to the console-wide text; a tab passes its own only when the boundary that
// applies to IT is narrower than the console's.
export function GmAccessDenied({ reason = GM_DENIED_REASON }: { reason?: string }) {
  return (
    <Card>
      <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>{reason}</p>
    </Card>
  );
}
