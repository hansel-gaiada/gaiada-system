"use client";
// SCP-5 W5-C5 (BFF §63.30.4, §63.30.5) — a preview box: what the section's UNSAVED value would do, asked of `POST rules/preview` (which saves nothing). It can name a client, for the previews that need one
// (the next cycle's steps, a client's score, and a report kind that is due on the client's own day). If the value is edited after a preview, the box says the answer is for the earlier edit.
import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import { previewRules } from "@/lib/socialRulesActions";
import { sameJson, type RulesPreview, type RulesSection } from "@/lib/socialRules";

export interface ClientChoice { engagementId: string; clientName: string }

export function RulesPreviewBox({ section, value, title, button, clients, clientRequired, render }: {
  section: RulesSection;
  /** The draft, as it would be saved. */
  value: unknown;
  title: string;
  button: string;
  /** The open clients, for the picker; null when they could not be read; undefined for a preview that needs none. */
  clients?: ClientChoice[] | null;
  /** The preview is empty without a client (the cycle's steps, a score). */
  clientRequired?: boolean;
  render: (p: RulesPreview) => ReactNode;
}) {
  const id = useId();
  const [engagementId, setEngagementId] = useState("");
  const [result, setResult] = useState<{ preview: RulesPreview; of: unknown } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const live = useRef<HTMLDivElement>(null);
  const needsClient = clientRequired && !engagementId;

  function run() {
    setProblem(null);
    const of = JSON.parse(JSON.stringify(value)) as unknown;
    start(async () => {
      const r = await previewRules(section, value, engagementId || null);
      if (!r.ok) { setProblem(r.message); setResult(null); return; }
      setResult({ preview: r.preview, of });
    });
  }
  return (
    <div className="rules__preview" role="group" aria-labelledby={`${id}-t`}>
      <p className="rules__preview-title" id={`${id}-t`}>{title}</p>
      {clients !== undefined && (
        clients === null
          ? <p className="scp-note" style={{ margin: 0 }}>The clients cannot be listed right now, so a client cannot be chosen.</p>
          : (
            <div className="rules__field">
              <label htmlFor={`${id}-c`}>For client</label>
              <select id={`${id}-c`} className="scp-input" value={engagementId} onChange={(e) => setEngagementId(e.target.value)}>
                <option value="">{clientRequired ? "Choose a client" : "No client chosen"}</option>
                {clients.map((c) => <option key={c.engagementId} value={c.engagementId}>{c.clientName}</option>)}
              </select>
            </div>
          )
      )}
      <div className="rules__buttons">
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={run} disabled={pending || needsClient} aria-describedby={needsClient ? `${id}-need` : undefined}>
          {pending ? "Working…" : button}
        </button>
      </div>
      {needsClient && <p className="scp-note" id={`${id}-need`} style={{ margin: 0 }}>Choose a client first.</p>}
      <div ref={live} aria-live="polite">
        {problem && <p className="scp-msg scp-msg--error" role="alert" style={{ margin: 0 }}>{problem}</p>}
        {result && (
          <>
            {!sameJson(result.of, value) && <p className="scp-note" style={{ margin: 0 }}>You have edited the values since this preview, so it shows the earlier edit. Preview again to update it.</p>}
            {render(result.preview)}
          </>
        )}
      </div>
    </div>
  );
}
