"use client";
// SCP-1c — the Settings page's first section: the ready-by buffer and the boost-candidate factor (BFF §63.4), and whether the company's holiday
// calendar is known (plan §10: a company without one gets weekends only, and the page says so).
//
// Editable only with `canPlan` (the server's answer to `social_engagement` · `plan`: the four Social approvers). Everyone else reads the values and
// the controls are DISABLED WITH THE REASON, in words on the page (`aria-describedby`) and as the button's `title`; the gate hides nothing it need not
// and grants nothing, the server's 403 `not_a_social_approver` is the boundary.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveSocialSettings } from "@/lib/socialCyclesActions";
import { PLAN_REFUSAL_REASON, type SocialSettings } from "@/lib/socialCycles";

export function SocialSettingsForm({ settings }: { settings: SocialSettings }) {
  const router = useRouter();
  const reasonId = useId();
  const [buffer, setBuffer] = useState(String(settings.bufferWorkingDays));
  const [factor, setFactor] = useState(String(settings.boostCandidateFactor));
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const locked = !settings.canPlan;

  const bufferN = Number(buffer);
  const factorN = Number(factor);
  const bufferOk = buffer.trim() !== "" && Number.isInteger(bufferN) && bufferN >= 0 && bufferN <= 10;
  const factorOk = factor.trim() !== "" && Number.isFinite(factorN) && factorN >= 1 && factorN <= 10 && Math.abs(Math.round(factorN * 100) - factorN * 100) < 1e-9;
  const dirty = bufferN !== settings.bufferWorkingDays || factorN !== settings.boostCandidateFactor;
  const canSave = !locked && !pending && dirty && bufferOk && factorOk;

  function save() {
    setMsg(null);
    const body: { bufferWorkingDays?: number; boostCandidateFactor?: number } = {};
    if (bufferN !== settings.bufferWorkingDays) body.bufferWorkingDays = bufferN;
    if (factorN !== settings.boostCandidateFactor) body.boostCandidateFactor = factorN;
    startTransition(async () => {
      const res = await saveSocialSettings(body);
      if (!res.ok) { setMsg({ kind: "error", text: res.message }); return; }
      const n = res.cyclesRecomputed;
      setMsg({ kind: "ok", text: n > 0 ? `Saved. ${n} open ${n === 1 ? "cycle's" : "cycles'"} ready-by date moved with the buffer.` : "Saved." });
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="scp-schedule-title">
      <h3 className="scp-section__title" id="scp-schedule-title">Schedule</h3>
      <p className="scp-lede">
        Ready-by is the client&rsquo;s deadline less the buffer, counted in working days. Changing the buffer moves the ready-by date of every open cycle.
      </p>
      <div className="scp-fields">
        <label className="scp-field">
          Buffer (working days)
          <input
            className="scp-input" type="number" inputMode="numeric" min={0} max={10} step={1}
            value={buffer} onChange={(e) => setBuffer(e.target.value)} disabled={locked || pending}
            aria-describedby={locked ? reasonId : undefined} aria-invalid={!bufferOk}
          />
          <span className="scp-field__hint">0 to 10. A buffer of 0 makes ready-by the deadline itself.</span>
        </label>
        <label className="scp-field">
          Boost-candidate factor
          <input
            className="scp-input" type="number" inputMode="decimal" min={1} max={10} step={0.05}
            value={factor} onChange={(e) => setFactor(e.target.value)} disabled={locked || pending}
            aria-describedby={locked ? reasonId : undefined} aria-invalid={!factorOk}
          />
          <span className="scp-field__hint">1 to 10, at most two decimals. How far above its usual reach a post must be to be offered as a boost candidate.</span>
        </label>
        <button
          type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={save} disabled={!canSave}
          title={locked ? PLAN_REFUSAL_REASON : undefined} aria-describedby={locked ? reasonId : undefined}
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
      {locked && <p className="scp-note scp-note--reason" id={reasonId}>{PLAN_REFUSAL_REASON}</p>}
      {msg && <p className={`scp-msg scp-msg--${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</p>}

      <p className="scp-calendar" style={{ marginTop: 16 }}>
        <span>Holiday calendar:</span>
        {settings.holidayCalendar.known
          ? <strong>{settings.holidayCalendar.name ?? "The company's default calendar"}</strong>
          : <>
              <strong>Weekends only</strong>
              <span className="scp-calendar__flag">No holiday calendar</span>
            </>}
      </p>
      {!settings.holidayCalendar.known && (
        <p className="scp-note">
          This company has no default holiday calendar, so only Saturdays and Sundays are off. Public holidays and joint-leave days count as working
          days here until one is set under HR &rsaquo; Settings.
        </p>
      )}
    </section>
  );
}
