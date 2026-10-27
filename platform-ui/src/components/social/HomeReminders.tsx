// SCP-Ki (SCP-Q24): the Reminders list of the Social Home, the design's reminder cards: a white box with a round icon, a bold one-line title, a grey sub-line and one solid
// button. Three kinds, in this order: today's check-in, the unit's pinned notice, and one card per report due (it was the side column's "Reports due" list). No visible
// heading (the design has none). It is drawn only when there is a card or a line to show, and a failed read says so in one quiet line, never as "nothing due".
import Link from "next/link";
import type { ReactNode } from "react";
import type { SubmitCheckinAction } from "@/components/dashboard/CheckinCard";
import type { CheckinCardData } from "@/lib/checkins-data";
import { formatDate } from "@/lib/format";
import type { NoticeList } from "@/lib/notices";
import type { ReadResult } from "@/lib/readResult";
import type { ReportDue } from "@/lib/socialHome";
import { checkinDue, pinnedNoticeReminder, reportDueSub, reportReminders } from "@/lib/socialHomeReminders";
import { HomeCheckinReminder } from "./HomeCheckinReminder";
import "./social-home.css";

function Card({ kind, icon, title, sub, action }: { kind: string; icon: ReactNode; title: string; sub: string; action: ReactNode }) {
  return (
    <li className="sh-rem" data-reminder={kind}>
      <div className="sh-rem__card">
        <span className="sh-rem__icon" aria-hidden="true">{icon}</span>
        <span className="sh-rem__text">
          <span className="sh-rem__title">{title}</span>
          <span className="sh-rem__sub">{sub}</span>
        </span>
        {action}
      </div>
    </li>
  );
}

const PinGlyph = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5M8 3h8l-1 7 3 3H6l3-3z" /></svg>
);

export function HomeReminders({ tenantId, deptId, checkin, submitCheckin, notices, reports, reportsFailure, now, profile }: {
  tenantId: string;
  deptId: string;
  /** `getCheckinCardData`'s answer: null when ANY check-in read failed. */
  checkin: CheckinCardData | null;
  submitCheckin: SubmitCheckinAction;
  notices: ReadResult<NoticeList>;
  /** The reports due (the allocation read, through `reportsDue`); null when that read did not succeed. */
  reports: ReportDue[] | null;
  /** The allocation read's failure, already worded (the Home's `Refused`); null when it succeeded. */
  reportsFailure: ReactNode;
  now: number;
  profile: (engagementId: string) => string;
}) {
  const notice = pinnedNoticeReminder(notices, deptId, now);
  const items: ReactNode[] = [];

  if (checkin === null) items.push(<li key="checkin" className="sh-rem__note">Check-in unavailable</li>);
  else if (checkinDue(checkin)) items.push(<HomeCheckinReminder key="checkin" tenantId={tenantId} data={checkin} submitAction={submitCheckin} />);

  if (notice.kind === "unavailable") items.push(<li key="notice" className="sh-rem__note">Notices unavailable</li>);
  else if (notice.kind === "card") {
    items.push(
      <Card key="notice" kind="notice" icon={PinGlyph} title={notice.title} sub={notice.sub}
        action={<Link href={notice.href} className="lux-btn lux-btn--solid lux-btn--sm sh-rem__btn" aria-label={`Read: ${notice.title}`}>Read</Link>} />,
    );
  }

  if (reportsFailure) items.push(<li key="reports" className="sh-rem__note">{reportsFailure}</li>);
  // "Open" for now; SCP-5a adds Write / Check, which need the report's state.
  const { cards, more } = reportReminders(reports ?? []);
  for (const r of cards) {
    items.push(
      <Card key={`report:${r.engagementId}`} kind="report" icon={r.clientName.charAt(0).toUpperCase()} title={`${r.clientName} monthly report`} sub={reportDueSub(r, formatDate)}
        action={<Link href={profile(r.engagementId)} className="lux-btn lux-btn--solid lux-btn--sm sh-rem__btn" aria-label={`Open ${r.clientName} monthly report`}>Open</Link>} />,
    );
  }

  if (more > 0) {
    items.push(
      <li key="more-reports" className="sh-rem__note">
        <Link href={`/departments/${encodeURIComponent(deptId)}/allocation`} className="scp-link">{more} more {more === 1 ? "report" : "reports"} due this week</Link>
      </li>,
    );
  }

  if (items.length === 0) return null;
  return (
    <section className="sh-section" aria-label="Reminders">
      <ul className="sh-rems">{items}</ul>
    </section>
  );
}
