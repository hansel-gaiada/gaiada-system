"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { registerExperimentAction } from "@/lib/experimentsActions";
import { EMPTY_FORM, GOAL_WORDS, type RegisterForm as Form } from "@/lib/experimentsModel";

// Register a test = write down its plan BEFORE it runs. Alpha (5%) and power (80%) are fixed by the server and shown as text,
// never sent. Every refusal comes back as a sentence from the action.
export function RegisterForm({ propertyId, tenantSlug, siteId, allowed }: { propertyId: string; tenantSlug: string; siteId: string; allowed: boolean }) {
  const router = useRouter();
  const [f, setF] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!allowed) return null;
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await registerExperimentAction(propertyId, { tenantSlug, siteId }, f);
    setBusy(false);
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setF(EMPTY_FORM); router.refresh(); }
  };

  return (
    <form onSubmit={submit} className="wa-page" aria-label="Register a test" data-testid="exp-register">
      <h2 className="av-h">Register a test</h2>
      <p className="wa-note">Write the plan down before the test runs. It cannot be changed once the test has started. Significance is fixed at 5% and power at 80%.</p>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-key">Key</label>
        <input id="ex-key" className="lux-field__control" value={f.key} onChange={set("key")} maxLength={64} /></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-hyp">What do you expect, and why?</label>
        <textarea id="ex-hyp" className="lux-field__control" value={f.hypothesis} onChange={set("hypothesis")} maxLength={500} rows={3} /></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-item">Page id</label>
        <input id="ex-item" className="lux-field__control" value={f.itemId} onChange={set("itemId")} /></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-sec">Section id</label>
        <input id="ex-sec" className="lux-field__control" value={f.sectionId} onChange={set("sectionId")} /></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-goal">Goal: counts when</label>
        <select id="ex-goal" className="lux-field__control" value={f.goalEvent} onChange={set("goalEvent")}>
          {Object.entries(GOAL_WORDS).map(([k, w]) => <option key={k} value={k}>{w}</option>)}
        </select></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-gm">Only for (optional)</label>
        <select id="ex-gm" className="lux-field__control" value={f.goalMatchKey} onChange={set("goalMatchKey")}>
          <option value="">Any</option><option value="form_id">One form</option><option value="link_location">One link spot</option><option value="section_id">One section</option>
        </select>
        {f.goalMatchKey ? <input aria-label="Which one" className="lux-field__control" value={f.goalMatchValue} onChange={set("goalMatchValue")} /> : null}</div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-base">Current goal rate, % (leave empty to use the last 28 days)</label>
        <input id="ex-base" inputMode="decimal" className="lux-field__control" value={f.baselinePct} onChange={set("baselinePct")} /></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-mde">Smallest change worth finding, % relative</label>
        <input id="ex-mde" inputMode="decimal" className="lux-field__control" value={f.mdePct} onChange={set("mdePct")} /></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-wa">Share of visitors: control (a), %</label>
        <input id="ex-wa" inputMode="numeric" className="lux-field__control" value={f.weightA} onChange={set("weightA")} /></div>
      <div className="lux-field"><label className="lux-field__label" htmlFor="ex-wb">Share of visitors: variant b, %</label>
        <input id="ex-wb" inputMode="numeric" className="lux-field__control" value={f.weightB} onChange={set("weightB")} /></div>
      <button type="submit" className="lux-btn lux-btn--solid lux-btn--md" disabled={busy}>{busy ? "Registering" : "Register test"}</button>
      {msg ? <p className={msg.ok ? "wa-note" : "wa-range__err"} role={msg.ok ? "status" : "alert"} data-testid="exp-register-msg">{msg.text}</p> : null}
    </form>
  );
}
