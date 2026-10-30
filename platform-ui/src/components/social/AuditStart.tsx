"use client";
// SCP-5g (BFF §63.28): the two ways to start an audit from the list. "Start audit" opens a client's draft for the last full month (a client with a draft answers it as it is: it is opened, not doubled);
// "New prospect audit" takes the prospect's name, an optional business type and the public numbers its twelve typed scores are read from. A client's audit is its officer's, the HoD's or the GM's and a
// prospect's is the four's (SCP-Q34): the server decides, and the refusal is said in words beside the button. Each click sends a fresh `id`, so a replay is the same audit.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { startClientAudit, startProspectAudit } from "@/lib/socialAuditActions";
import { newUuid } from "@/lib/socialClient";
import {
  AUDIT_LIMITS, PROSPECT_WRITE_REASON, PUBLIC_KEYS, PUBLIC_LABEL, auditHref, buildProspectCreate, emptyPublicNumbers, type AuditForm,
} from "@/lib/socialAudit";
import type { Refusal } from "@/lib/socialPipeline";
import "./cycles.css";
import "./audit.css";

export function AuditStartButton({ deptId, engagementId, clientName }: { deptId: string; engagementId: string; clientName: string }) {
  const router = useRouter();
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [pending, start] = useTransition();
  function go() {
    setRefusal(null);
    start(async () => {
      const r = await startClientAudit(engagementId, newUuid());
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      router.push(auditHref(deptId, r.audit.id));
    });
  }
  return (
    <>
      <button type="button" className="lux-btn lux-btn--sm" disabled={pending} aria-label={`Start audit for ${clientName}`} onClick={go}>{pending ? "Starting…" : "Start audit"}</button>
      {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
    </>
  );
}

export function ProspectAuditForm({ deptId, canAdd }: { deptId: string; canAdd: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [pub, setPub] = useState<AuditForm["publicNumbers"]>(emptyPublicNumbers);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [pending, start] = useTransition();
  if (!canAdd) return <p className="scp-note scp-note--reason">{PROSPECT_WRITE_REASON} A client&apos;s audit is started from its row below.</p>;

  function create() {
    setRefusal(null);
    const check = buildProspectCreate({ prospectName: name, businessType, publicNumbers: pub }, newUuid());
    if (!check.ok) { setProblem(check.message); return; }
    setProblem(null);
    start(async () => {
      const r = await startProspectAudit(check.body);
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      router.push(auditHref(deptId, r.audit.id));
    });
  }
  return (
    <details className="scp-saved__add">
      <summary>New prospect audit</summary>
      <form className="scp-audit__panel" aria-label="New prospect audit" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <p className="scp-lede" style={{ margin: 0 }}>A prospect has no pipeline, so all twelve scores are typed from what is public. Keep the public numbers you read them from.</p>
        <div className="scp-audit__inputs">
          <div className="scp-field">
            <label htmlFor={`${uid}-name`}>Prospect&apos;s name</label>
            <input id={`${uid}-name`} className="scp-input" value={name} maxLength={AUDIT_LIMITS.prospectName} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="scp-field">
            <label htmlFor={`${uid}-type`}>Business type (optional)</label>
            <input id={`${uid}-type`} className="scp-input" value={businessType} maxLength={AUDIT_LIMITS.businessType} onChange={(e) => setBusinessType(e.target.value)} />
          </div>
        </div>
        <div className="scp-audit__inputs" role="group" aria-label="Public numbers">
          {PUBLIC_KEYS.map((k) => (
            <div key={k} className="scp-field">
              <label htmlFor={`${uid}-${k}`}>{PUBLIC_LABEL[k]}</label>
              <input
                id={`${uid}-${k}`} className="scp-input" inputMode={k === "lastPostOn" ? undefined : "decimal"} placeholder={k === "lastPostOn" ? "YYYY-MM-DD" : ""}
                value={pub[k]} onChange={(e) => setPub((p) => ({ ...p, [k]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        {problem && <p className="scp-msg scp-msg--error" role="alert">{problem}</p>}
        <div className="scp-audit__buttons">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Creating…" : "Create the audit"}</button>
        </div>
        {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
      </form>
    </details>
  );
}
