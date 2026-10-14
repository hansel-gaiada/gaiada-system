import { SIMULATED_NOTICE_FALLBACK } from "@/lib/simulatedPsre";
import "./simulatedPsre.css";

// PV5-11 — the banner at the top of every simulated PSrE signing page. It says, in words and at full contrast, that this is
// NOT a real certified signature (owner ruling PV-D43). The notice is the backend's own sentence; when it is missing the
// fixed fallback is shown, so the page can never be rendered without the statement. `role="note"`, not an alert: it is
// permanent context, not an event.
export function SimulatedBanner({ label, notice }: { label: string | null; notice: string | null | undefined }) {
  return (
    <div className="sp-banner" role="note" aria-label="Simulated signing">
      <span className="sp-banner__label">{label ?? "Simulated PSrE (review stage)"}</span>
      <p className="sp-banner__notice">{notice && notice.trim() ? notice : SIMULATED_NOTICE_FALLBACK}</p>
    </div>
  );
}
