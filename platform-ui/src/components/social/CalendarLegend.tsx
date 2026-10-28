// SCP-1k, SCP-3e — the legend of the Social Media calendars (the client's tab and the all-clients page): one entry per phase of the fixture, in its order, drawn
// with the same token as the chips; the all-clients page adds the Composer post and the holiday and leave marks it draws. Every entry is written, so colour is
// never the only signal.
import type { CSSProperties } from "react";
import { PHASE_LEGEND } from "@/lib/socialClient";
import { COMPOSER_LEGEND } from "@/lib/socialCalendar";

export function CalendarLegend({ composer = false, hr = false }: { composer?: boolean; hr?: boolean }) {
  return (
    <ul className="scp-legend" aria-label="Phase colours">
      {PHASE_LEGEND.map((p) => (
        <li key={p.key} className="scp-legend__item">
          <span className="scp-legend__dot" style={{ "--scp-phase": p.token } as CSSProperties} aria-hidden="true" />
          {p.label}
        </li>
      ))}
      {composer && (
        <li className="scp-legend__item">
          <span className="scp-legend__dot scp-legend__dot--composer" aria-hidden="true" />
          {COMPOSER_LEGEND.label}
        </li>
      )}
      {hr && (
        <>
          <li className="scp-legend__item">
            <span className="scp-legend__dot scp-legend__dot--holiday" aria-hidden="true" />
            Holiday
          </li>
          <li className="scp-legend__item">
            <span className="scp-legend__dot scp-legend__dot--away" aria-hidden="true" />
            Away (approved leave)
          </li>
        </>
      )}
    </ul>
  );
}
