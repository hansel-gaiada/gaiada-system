"use client";
import { useId, useState } from "react";
import { CheckinCard, type SubmitCheckinAction } from "@/components/dashboard/CheckinCard";
import type { CheckinCardData } from "@/lib/checkins-data";

// SCP-Ki (SCP-Q24): today's check-in as a reminder card. The button is a disclosure that opens the EXISTING `CheckinCard` right under the card (the form is not rebuilt, so
// the backend's draft is still one click from "Confirm & submit"). After a submit the card shows its own "already submitted" line; on the next load this card is gone.
export function HomeCheckinReminder({ tenantId, data, submitAction }: { tenantId: string; data: CheckinCardData; submitAction: SubmitCheckinAction }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <li className="sh-rem" data-reminder="checkin">
      <div className="sh-rem__card">
        <span className="sh-rem__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </span>
        <span className="sh-rem__text">
          <span className="sh-rem__title">Today&rsquo;s check-in</span>
          <span className="sh-rem__sub">Your draft is ready. Check it and send it.</span>
        </span>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm sh-rem__btn" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>Check in</button>
      </div>
      <div id={panel} className="sh-rem__panel" hidden={!open}>
        {open && <CheckinCard tenantId={tenantId} today={data.today} selfCompliance={data.selfCompliance} submitAction={submitAction} />}
      </div>
    </li>
  );
}
