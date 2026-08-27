import { Card, HairlineTable, StatusBadge, Button, Eyebrow } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { DegradeBanner } from "./DegradeBanner";
import type { ReleaseFact, DegradeMeta } from "@/lib/webdesk";
import type { AutomationApproval } from "@/lib/automationApprovals";

const KIND_LABEL: Record<ReleaseFact["kind"], string> = {
  "deploy.done": "Deployed to staging",
  "promote.done": "Promoted to live",
  "rollback.done": "Rolled back",
};

/** Best-effort match of a WS4 automation-approval row to THIS site, mirroring the same "unpinned
 *  until a real emitter exists" doctrine §24 already applies to release facts: `tool_args` isn't a
 *  typed contract yet (no real webdev write command exists to have shaped it), so this checks the
 *  handful of field names the design doc's own vocabulary uses (`siteSlug`/`slug`/
 *  `webdeskTenantSlug`) rather than asserting a shape nobody has built. */
function matchesSite(a: AutomationApproval, slug: string): boolean {
  const args = a.tool_args as Record<string, unknown>;
  const candidates = [args?.siteSlug, args?.slug, args?.webdeskTenantSlug];
  return candidates.some((v) => typeof v === "string" && v === slug);
}

/** design §08 button matrix: "Promote to live / rollback — always 🔴 WS4"; "Deploy to staging —
 *  submission-approved + QA green-or-override". WSK-23's own finding is why every one of these is
 *  disabled today regardless of role or WS4 state: Zone B's control plane (WSK-21) ships only three
 *  GET routes — there is no write route for ANY of these actions to call yet. Rendering them as live
 *  buttons that 501/404 the moment someone clicks would be worse than not having them; this ticket's
 *  own instruction is disabled-with-reason, not a button that fails. */
const ACTIONS: { key: string; label: string; reason: string }[] = [
  { key: "deploy", label: "Deploy to staging", reason: "No write route exists on Zone B's control plane yet (WSK-21 ships reads only)." },
  { key: "promote", label: "Promote to live", reason: "Always requires WS4 approval, and the write channel itself isn't built yet (WSK-22)." },
  { key: "rollback", label: "Rollback", reason: "Always requires WS4 approval, and the write channel itself isn't built yet (WSK-22)." },
];

export function ReleaseActionsPanel({
  slug, releases, meta, approvals,
}: {
  slug: string;
  releases: ReleaseFact[];
  meta: DegradeMeta;
  /** Already fetched with `origin=webdev` — this component does the per-site match. `null` means
   *  the read itself was unavailable (distinct from "read fine, zero rows"). */
  approvals: AutomationApproval[] | null;
}) {
  const matched = approvals?.filter((a) => matchesSite(a, slug)) ?? [];

  return (
    <Card title="Releases">
      <DegradeBanner meta={meta} subject="this site's release history" />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {ACTIONS.map((a) => (
          <div key={a.key} style={{ display: "grid", gap: 4, maxWidth: 240 }}>
            <Button disabled>{a.label}</Button>
            <span style={{ font: "400 11px/1.4 var(--font-body)", color: "var(--erp-ink-50)" }}>{a.reason}</span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 16 }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>WS4 decisions on file (origin: webdev)</Eyebrow>
        {approvals === null ? (
          <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>Couldn&apos;t be read right now.</p>
        ) : matched.length === 0 ? (
          <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>No WS4 decisions on file for this site yet.</p>
        ) : (
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {matched.map((a) => (
              <li key={a.id} style={{ font: "400 13px/1.6 var(--font-body)" }}>
                <StatusBadge label={a.status} /> {a.tool_name} — requested by {a.requested_by}, {formatDateTime(a.created_at)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {releases.length === 0 ? (
        <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>No release facts on file for this site yet.</p>
      ) : (
        <HairlineTable
          columns={[{ label: "Event" }, { label: "Received", align: "right" }]}
          tcols="1fr 1fr"
          rows={releases.map((r) => [KIND_LABEL[r.kind] ?? r.kind, formatDateTime(r.receivedAt)])}
        />
      )}
    </Card>
  );
}
