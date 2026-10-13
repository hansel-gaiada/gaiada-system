import Link from "next/link";
import type { QueueItem } from "@/lib/queueUrgency";
import type { CheckinCardData } from "@/lib/checkins-data";
import { CheckinCard, type SubmitCheckinAction } from "@/components/dashboard/CheckinCard";
import { LauncherRow, type LauncherItem } from "@/components/departments/LauncherRow";

// DW-3c: the Overview's "Today" block, three honest parts. Today's check-in (the card as it is on the classic
// home, so it can still be submitted from here), what is due today, and the workspace's tools as the
// department Home draws them. No calendar events exist yet (DW-8g), so none are shown.
//
// Each part says what happened to its own read: a check-in that could not be read says so rather than vanish,
// and an unreadable due list is "unavailable", never "nothing due".
export function TodayBlock({ tenantId, checkin, submitAction, dueToday, partial, tools }: {
  tenantId: string;
  /** `getCheckinCardData`'s answer: null when ANY check-in read failed. */
  checkin: CheckinCardData | null;
  submitAction: SubmitCheckinAction;
  /** Items due today; null when the queue could not be read at all. */
  dueToday: QueueItem[] | null;
  /** Some queue sources could not be read, so the due list may be short. */
  partial: boolean;
  tools: LauncherItem[];
}) {
  return (
    <section className="ov-block ov-today" aria-label="Today">
      <h3 className="ov-block__title">Today</h3>

      {checkin ? (
        <CheckinCard tenantId={tenantId} today={checkin.today} selfCompliance={checkin.selfCompliance} submitAction={submitAction} />
      ) : (
        <p className="ov-block__note">Check-in unavailable</p>
      )}

      <div className="ov-today__part">
        <h4 className="ov-block__sub">Due today</h4>
        {dueToday === null ? (
          <p className="ov-block__note">Due today is unavailable</p>
        ) : dueToday.length === 0 ? (
          <p className="ov-block__note">{partial ? "Nothing found in the sources that could be read." : "Nothing due today"}</p>
        ) : (
          <ul className="ov-today__list">
            {dueToday.map((item) => (
              <li key={item.id} className="ov-today__item">
                {item.href ? <Link href={item.href} className="ov-today__link">{item.title}</Link> : item.title}
                {item.meta && <span className="ov-today__meta"> · {item.meta}</span>}
              </li>
            ))}
          </ul>
        )}
        {dueToday !== null && partial && dueToday.length > 0 && <p className="ov-block__note">Some sources could not be read</p>}
      </div>

      {tools.length > 0 && (
        <div className="ov-today__part">
          <h4 className="ov-block__sub">Tools</h4>
          <LauncherRow items={tools} />
        </div>
      )}
    </section>
  );
}
