import Link from "next/link";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { partFailureWords } from "@/lib/webdeskCalendarModel";
import type { WdResult } from "@/lib/webdeskContentModel";
import "./editorial.css";

/**
 * A calendar or board read that did not return data. A 503 that names the part the BFF could not read says WHICH part in words (and that
 * nothing is shown rather than a list that may be missing items); everything else is the shared refusal. Never an empty calendar.
 */
export function CalendarRefusal({ result, subject, retryHref }: { result: Exclude<WdResult<unknown>, { kind: "ok" }>; subject: string; retryHref: string }) {
  const words = partFailureWords(result);
  if (words === null) return <WdRefusal result={result} subject={subject} retryHref={retryHref} />;
  return (
    <div className="wc-notice" role="alert" data-testid="calendar-part-unreadable">
      <h2>The calendar can&apos;t be shown</h2>
      <p>{words}</p>
      <div className="wc-notice__actions">
        <Link href={retryHref} className="lux-btn lux-btn--ghost lux-btn--sm">Try again</Link>
      </div>
    </div>
  );
}
