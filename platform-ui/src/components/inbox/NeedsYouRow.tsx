"use client";
import { useId, useState, type ReactNode } from "react";
import "./needsYouRow.css";

// SCP-Kh (SCP-Q24): "Needs you" as the first row of the Inbox, a disclosure that opens in place to the queue
// (the server component passes the `NeedsYouBlock` in as `children`). The summary and the dot are decided by the
// server from every item; this only draws them and owns open/closed (default closed). When the read failed there
// is nothing to open, so the head is a disabled button and no panel exists.
export function NeedsYouRow({ line, waiting = false, expandable = true, children }: {
  line: string;
  /** Something waits: the red dot. */
  waiting?: boolean;
  /** False when the queue could not be read at all, or is still being read: nothing to open. */
  expandable?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section className="ny-row" aria-label="Needs you">
      <button
        type="button"
        className="ny-row__head"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? panelId : undefined}
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ny-row__text">
          <span className="ny-row__title">Needs you</span>
          <span className="ny-row__line">{line}</span>
        </span>
        {waiting && <span className="ny-row__dot" role="img" aria-label="Something is waiting" />}
        {expandable && (
          <svg className="ny-row__chev" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {expandable && (
        <div id={panelId} className="ny-row__panel" hidden={!open}>{children}</div>
      )}
    </section>
  );
}
