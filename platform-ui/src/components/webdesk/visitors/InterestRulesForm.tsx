"use client";
import { useRef, useState } from "react";
import { saveInterestRulesAction } from "@/lib/visitorsActions";
import { checkRuleDrafts, type InterestRule, type RuleDraft } from "@/lib/visitorsModel";
import "../content/content.css";
import "./visitors.css";

// Website -> Visitors -> Interest rules. The rule set is saved COMPLETE (a row removed here is removed on the server), through a
// server action. A refusal is one sentence in place; a success says what the server said (interests follow at the next daily
// refresh). Nothing is optimistic: the list shown is the one the server last answered with.

type Row = RuleDraft & { key: number };
const blank = (key: number): Row => ({ key, match: "path_prefix", pattern: "", facet: "service", tag: "", weight: 1 });

export function InterestRulesForm({ propertyId, initial, note }: { propertyId: string; initial: InterestRule[]; note: string }) {
  const nextKey = useRef(initial.length);
  const [rows, setRows] = useState<Row[]>(() => initial.map((r, i) => ({ key: i, match: r.match, pattern: r.pattern, facet: r.facet, tag: r.tag, weight: r.weight })));
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const set = (key: number, patch: Partial<RuleDraft>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async () => {
    if (inflight.current) return;
    const drafts: RuleDraft[] = rows.map(({ match, pattern, facet, tag, weight }) => ({ match, pattern: pattern.trim(), facet, tag: tag.trim(), weight: Number(weight) }));
    const bad = checkRuleDrafts(drafts);
    if (bad) { setMsg({ tone: "bad", text: bad }); return; }
    inflight.current = true; setBusy(true); setMsg(null);
    try {
      const r = await saveInterestRulesAction(propertyId, drafts);
      if (r.ok) {
        nextKey.current = r.rules.length;
        setRows(r.rules.map((x, i) => ({ key: i, match: x.match, pattern: x.pattern, facet: x.facet, tag: x.tag, weight: x.weight })));
        setMsg({ tone: "ok", text: `Saved ${r.rules.length} ${r.rules.length === 1 ? "rule" : "rules"}. ${r.note}` });
      } else setMsg({ tone: "bad", text: r.message });
    } catch {
      setMsg({ tone: "bad", text: "The rules could not be saved just now. Nothing was changed. Try again in a moment." });
    } finally { inflight.current = false; setBusy(false); }
  };

  return (
    <div className="wv-rules" data-testid="interest-rules-form">
      <p className="wv-note" data-testid="rules-note">{rows.length === 0 && !msg ? "No rules yet, so no visitor has any interests." : note}</p>
      {rows.map((r, i) => (
        <div key={r.key} className="wv-rule" data-testid="rule-row">
          <div className="lux-field"><label className="lux-field__label" htmlFor={`wv-m-${r.key}`}>Matches</label>
            <select id={`wv-m-${r.key}`} className="lux-field__control" value={r.match} onChange={(e) => set(r.key, { match: e.target.value as RuleDraft["match"] })}>
              <option value="path_prefix">Page path starts with</option><option value="section_prefix">Section starts with</option>
            </select></div>
          <div className="lux-field wv-rule__pattern"><label className="lux-field__label" htmlFor={`wv-p-${r.key}`}>Pattern</label>
            <input id={`wv-p-${r.key}`} className="lux-field__control" value={r.pattern} maxLength={200} onChange={(e) => set(r.key, { pattern: e.target.value })} placeholder={r.match === "path_prefix" ? "/services/web/" : "pricing"} /></div>
          <div className="lux-field"><label className="lux-field__label" htmlFor={`wv-f-${r.key}`}>Interest kind</label>
            <select id={`wv-f-${r.key}`} className="lux-field__control" value={r.facet} onChange={(e) => set(r.key, { facet: e.target.value as RuleDraft["facet"] })}>
              <option value="service">Service</option><option value="industry">Industry</option>
            </select></div>
          <div className="lux-field"><label className="lux-field__label" htmlFor={`wv-t-${r.key}`}>Tag</label>
            <input id={`wv-t-${r.key}`} className="lux-field__control" value={r.tag} maxLength={40} onChange={(e) => set(r.key, { tag: e.target.value })} placeholder="web-design" /></div>
          <div className="lux-field wv-rule__weight"><label className="lux-field__label" htmlFor={`wv-w-${r.key}`}>Weight</label>
            <input id={`wv-w-${r.key}`} type="number" min={1} max={10} className="lux-field__control" value={Number.isNaN(r.weight) ? "" : r.weight} onChange={(e) => set(r.key, { weight: e.target.value === "" ? Number.NaN : Number(e.target.value) })} /></div>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Remove rule ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>Remove</button>
        </div>
      ))}
      <div className="wv-actions">
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setRows((rs) => [...rs, blank(nextKey.current++)])} disabled={rows.length >= 100}>Add a rule</button>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--md" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save rules"}</button>
      </div>
      {msg ? <p className={msg.tone === "ok" ? "wv-ok" : "wv-err"} role={msg.tone === "ok" ? "status" : "alert"} data-testid={`rules-${msg.tone}`}>{msg.text}</p> : null}
      <p className="wv-note">Saving replaces the whole set: a rule you remove here is removed. Weights run from 1 to 10.</p>
    </div>
  );
}
