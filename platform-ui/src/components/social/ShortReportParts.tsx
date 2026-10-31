"use client";
// SCP-5 W5-A4 (BFF §63.24.7): the parts of a short kind's report page (daily, weekly) that the monthly's page does not have: the period's navigation (the period before and the period after, each the
// report itself when there is one, else a button that drafts it), the best post of the period, and the next period from the pipeline. Tables are the report document's own (`best_post`, `next_period`),
// drawn here under their own headings; the server's numbers are shown as they came and never recomputed.
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { newUuid } from "@/lib/socialClient";
import type { Refusal } from "@/lib/socialPipeline";
import type { ReportTable } from "@/lib/reports";
import { dayWords } from "@/lib/socialReportKinds";
import { reportHref, type ReportNavLink } from "@/lib/socialReports";
import { draftReport } from "@/lib/socialReportsActions";
import "./cycles.css";
import "./reports.css";

/** The period before or after: previous and next. */
export function PeriodNav({ deptId, engagementId, kind, prev, next }: { deptId: string; engagementId: string; kind: string; prev: ReportNavLink | null; next: ReportNavLink | null }) {
  const router = useRouter();
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  function draft(l: ReportNavLink) {
    setRefusal(null); setBusy(l.period);
    start(async () => {
      const r = await draftReport(engagementId, kind, l.period, newUuid());
      setBusy(null);
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      router.push(reportHref(deptId, r.report.id));
    });
  }

  const item = (l: ReportNavLink | null, which: "Previous" | "Next") => {
    if (!l) return <span className="scp-field__hint">{which === "Next" ? "The next period has not begun." : "No earlier period."}</span>;
    if (l.reportId) return <Link className="scp-link" href={reportHref(deptId, l.reportId)} rel={which === "Previous" ? "prev" : "next"}>{which}: {l.label}</Link>;
    return (
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} aria-label={`${which}: draft the report for ${l.label}`} onClick={() => draft(l)}>
        {busy === l.period ? "Drafting…" : `${which}: draft ${l.label}`}
      </button>
    );
  };
  return (
    <nav className="scp-report__nav" aria-label="Report periods">
      {item(prev, "Previous")}
      {item(next, "Next")}
      {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
    </nav>
  );
}

const text = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** The best post of the period by reach: a table of one row when a post has a reach, else a plain line saying so. */
export function BestPost({ table, headingId }: { table: ReportTable | undefined; headingId: string }) {
  const row = table?.rows[0];
  return (
    <section aria-labelledby={headingId}>
      <h3 className="scp-post__section-title" id={headingId}>Best post</h3>
      {!row ? <p className="scp-note" style={{ margin: 0 }}>No post of this period has a reach yet.</p> : (
        <p style={{ margin: 0 }}>
          <strong>{text(row.post)}</strong> on {text(row.network)}{row.publishedAt ? `, published ${text(row.publishedAt).slice(0, 10)}` : ""}, reach {typeof row.reach === "number" ? row.reach.toLocaleString("en-US") : text(row.reach)}.
        </p>
      )}
    </section>
  );
}

/** The next period from the pipeline: the client's posts dated in the next day or week, archived and deleted ones left out. Nothing dated is said plainly, as a fact. */
export function ComingUp({ deptId, table, word, headingId }: { deptId: string; table: ReportTable | undefined; word: "day" | "week"; headingId: string }) {
  const rows = table?.rows ?? [];
  return (
    <section aria-labelledby={headingId}>
      <h3 className="scp-post__section-title" id={headingId}>Coming up the next {word}</h3>
      {rows.length === 0 ? <p className="scp-note" style={{ margin: 0 }}>Nothing is dated for the next {word} in the pipeline.</p> : (
        <table className="scp-reports__table">
          <caption className="scp-field__hint" style={{ textAlign: "left", paddingBottom: 6 }}>{rows.length} {rows.length === 1 ? "post" : "posts"} from the pipeline</caption>
          <thead><tr><th scope="col">Post</th><th scope="col">Format</th><th scope="col">Scheduled</th><th scope="col">Where it is</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${text(r.postId)}-${i}`}>
                <td>{typeof r.postId === "string" ? <Link className="scp-link" href={`/departments/${encodeURIComponent(deptId)}/posts/${encodeURIComponent(r.postId)}`}>{text(r.title)}</Link> : text(r.title)}</td>
                <td>{text(r.format)}</td>
                <td>{r.scheduledAt ? dayWords(text(r.scheduledAt).slice(0, 10)) : ""}</td>
                <td>{text(r.phaseLabel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
