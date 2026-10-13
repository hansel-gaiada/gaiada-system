"use client";
// PV5-14 / PV-D40 — the header badge while a SIMULATED second factor holds this sign-in at high assurance:
// "Second factor simulated until HH:MM". Fed by `/api/me` (`assuranceSource: "simulated"`, `assuranceExpiresAt`),
// so it costs no extra request. Client-side so HH:MM is the viewer's own clock; it renders nothing until mounted
// (no server/client clock mismatch) and nothing once the time has passed.
import { useEffect, useState } from "react";
import { simulatedBadgeText } from "@/lib/stepUp";
import "./second-factor.css";

export function SimulatedFactorBadge({ expiresAt }: { expiresAt: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setText(simulatedBadgeText(expiresAt));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!text) return null;
  return (
    <span className="erp-sf-badge" role="status" title="Dev stage: a simulated second factor, not a real one. Recorded in the activity log.">
      {text}
    </span>
  );
}
