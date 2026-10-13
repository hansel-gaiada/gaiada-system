"use client";
// PV5-14 / PV-D40 — shown where a refusal names assurance (403 `reason: "assurance_required"`): says "This action
// needs a second factor" and, ONLY when the platform says simulation is available for this sign-in, offers the
// "Simulate second factor (dev stage)" button. Never presents the simulation as real MFA (see lib/stepUp.ts).
//
// The availability read happens on mount, through a server action, so a page that never hits such a refusal never
// pays for it. Off (the route 404s) or unavailable for this person: only the sentence shows.
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { STEP_UP_TEXT, hhmm, type StepUpStatus } from "@/lib/stepUp";
import { getStepUpStatusAction, simulateSecondFactorAction } from "@/lib/stepUpActions";
import "./second-factor.css";

export function SecondFactorPrompt({ returnTo, onSimulated }: {
  /** Where to send the person after simulating (the /step-up page passes `?return=`); omitted = stay and refresh. */
  returnTo?: string;
  onSimulated?: (expiresAt: string) => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<StepUpStatus | null | undefined>(undefined);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => getStepUpStatusAction())
      .then((s) => { if (live) setStatus(s); })
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, []);

  function simulate() {
    setError(null);
    start(async () => {
      const r = await simulateSecondFactorAction();
      if (!r.ok) return setError(r.error);
      setUntil(r.expiresAt);
      onSimulated?.(r.expiresAt);
      if (returnTo) router.push(returnTo);
      else router.refresh();
    });
  }

  return (
    <div className="erp-sf" role="region" aria-label="Second factor">
      <p className="erp-sf__title">{STEP_UP_TEXT.needs}</p>
      {until ? (
        <p className="erp-sf__note" role="status">
          Second factor simulated until {hhmm(until)}. Try the action again.
        </p>
      ) : status?.available ? (
        <>
          <p className="erp-sf__note">{STEP_UP_TEXT.explain}</p>
          <div className="erp-sf__actions">
            <Button onClick={simulate} disabled={pending}>{pending ? "Working…" : STEP_UP_TEXT.button}</Button>
          </div>
        </>
      ) : status === undefined ? null : (
        <p className="erp-sf__note">{STEP_UP_TEXT.unavailable}</p>
      )}
      {error && <p className="erp-sf__error" role="alert">{error}</p>}
    </div>
  );
}
