import { Card, HairlineTable } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { DegradeBanner } from "./DegradeBanner";
import type { SubmissionFact, DegradeMeta } from "@/lib/webdesk";

// design §08: "Submissions — per-form recent submissions (read-only projection; PII-aware —
// respects retention)." §24 confirms this is PII-aware BY CONSTRUCTION, not by client-side
// filtering: Zone A never receives submission content over the bridge at all — the row shape
// (`submissionId, formId, hasAttachments, receivedAt`) is all the backend has ever sent, so there
// is no content field this component could leak even by accident.
export function SubmissionsPanel({
  submissions, meta, formId,
}: {
  submissions: SubmissionFact[];
  meta: DegradeMeta;
  formId?: string;
}) {
  return (
    <Card title="Submissions">
      <DegradeBanner meta={meta} subject="this site's form submissions" />

      <p style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-50)", marginBottom: 12 }}>
        Receipts only — full submission content stays on WebDesk and never reaches this console.
      </p>

      {/* Plain GET form, no client JS needed: the page itself reads `?formId=` server-side. */}
      <form method="GET" style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.6 }}>Form ID</span>
          <input type="text" name="formId" defaultValue={formId ?? ""} placeholder="all forms" />
        </label>
        <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Filter</button>
      </form>

      {submissions.length === 0 ? (
        <p style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
          No submissions on file for {formId ? `form "${formId}" on` : ""} this site{formId ? "" : " yet"}.
        </p>
      ) : (
        <HairlineTable
          columns={[{ label: "Form" }, { label: "Attachments" }, { label: "Received", align: "right" }]}
          tcols="1fr 1fr 1fr"
          rows={submissions.map((s) => [s.formId, s.hasAttachments ? "Yes" : "No", formatDateTime(s.receivedAt)])}
        />
      )}
    </Card>
  );
}
