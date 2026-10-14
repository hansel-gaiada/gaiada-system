"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { eventButtons, type CalendarEventDetail, type EventActionResult, type EventAnswer } from "@/lib/calendarEvents";
import "./calendar.css";

// DW-8g: the buttons on the event page. WHICH buttons show is Cerbos's answer carried on the event (`canEdit`,
// `canCancel`, `canRespond`), through the pure `eventButtons`; this file never works it out from a role. Writes are
// passed in, so a test can drive them. Cancelling asks first, because everyone invited is told.
export function EventActions({
  event, editHref, respond, cancel,
}: {
  event: Pick<CalendarEventDetail, "canEdit" | "canCancel" | "canRespond" | "status" | "myResponse">;
  editHref: string;
  respond: (answer: EventAnswer) => Promise<EventActionResult>;
  cancel: () => Promise<EventActionResult>;
}) {
  const router = useRouter();
  const show = eventButtons(event);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<EventActionResult>) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.ok) { setConfirming(false); router.refresh(); } else setError(r.error);
    });
  }

  if (!show.respond && !show.edit && !show.cancel) return null;

  const answers: { value: EventAnswer; label: string }[] = [
    { value: "accepted", label: "Accept" }, { value: "tentative", label: "Maybe" }, { value: "declined", label: "Decline" },
  ];

  return (
    <div className="cal-event__row" role="group" aria-label="Event actions">
      {show.respond && answers.map((a) => (
        <button
          key={a.value} type="button" disabled={pending}
          className={`lux-btn lux-btn--${event.myResponse === a.value ? "solid" : "ghost"} lux-btn--sm`}
          aria-pressed={event.myResponse === a.value}
          onClick={() => run(() => respond(a.value))}
        >
          {a.label}
        </button>
      ))}
      {show.edit && <Link href={editHref} className="lux-btn lux-btn--ghost lux-btn--sm">Edit</Link>}
      {show.cancel && !confirming && <Button variant="ghost" onClick={() => setConfirming(true)}>Cancel event</Button>}
      {show.cancel && confirming && (
        <span className="cal-event__row" role="alertdialog" aria-label="Confirm cancelling this event">
          <span>Cancel this event? Everyone invited is told.</span>
          <Button disabled={pending} onClick={() => run(cancel)}>Yes, cancel it</Button>
          <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>Keep it</Button>
        </span>
      )}
      {error && <p className="lux-field__error" role="alert" style={{ flexBasis: "100%", margin: 0 }}>{error}</p>}
    </div>
  );
}
