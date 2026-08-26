import type { FlowCounts } from "@/lib/prdFlow";
import "./prd-studio.css";

// The tab's table of contents and progress bar in one strip: the four beats a briefing goes
// through, in the order a person does them, each with what is waiting there right now. Numbered
// because this IS a sequence — a briefing cannot be converted before it is transcribed, or approved
// before it is converted. Server-safe: no hooks, so the page can render it with its data.
export function PrdFlowHeader({ counts }: { counts: FlowCounts }) {
  const c = counts;
  const step4 = [c.awaitingGm > 0 && `${c.awaitingGm} with the GM`, c.awaitingClient > 0 && `${c.awaitingClient} with the client`]
    .filter(Boolean)
    .join(" · ");
  const step2 = [c.processing > 0 && `${c.processing} transcribing`, c.failed > 0 && `${c.failed} failed`].filter(Boolean).join(" · ");

  const beats: Array<{ label: string; live: string | null; quiet: string }> = [
    { label: "Create a briefing", live: c.toCapture > 0 ? `${c.toCapture} waiting for a recording` : null, quiet: "Start below" },
    { label: "Add the recording", live: step2 || null, quiet: "Record here, use the helper, or upload" },
    { label: "Convert to a PRD run", live: c.readyToConvert > 0 ? `${c.readyToConvert} ready to convert` : null, quiet: "Unlocks once transcribed" },
    { label: "Get it approved", live: step4 || null, quiet: c.complete > 0 ? `${c.complete} done` : "GM review, then the client signs" },
  ];

  return (
    <ol className="prd-flow" aria-label="How a briefing becomes an approved PRD">
      {beats.map((b, i) => (
        <li key={b.label} className="prd-flow__beat">
          <span className="prd-flow__num">Step {i + 1}</span>
          <span className="prd-flow__label">{b.label}</span>
          <span className={b.live ? "prd-flow__count prd-flow__count--live" : "prd-flow__count"}>{b.live ?? b.quiet}</span>
        </li>
      ))}
    </ol>
  );
}
