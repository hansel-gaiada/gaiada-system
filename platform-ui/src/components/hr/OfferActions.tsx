"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { offerMoves, type StatusMove } from "@/lib/hrRecruitment";
import { ResultMessage, panelStyle, textStyle, type Msg } from "./RecruitmentBits";

// The controls for one offer (DW-7f-2). Which buttons appear MIRRORS the server: the status moves are the manage
// tier (hr.recruitment.manage); converting is hr.recruitment.approve, and the server also needs a high-assurance
// sign-in, which the page cannot see, so the button shows and a refusal is said in the server's words. The server
// accepts any status move except from `converted`, so the moves offered are a narrower, sensible set.
//
// CONVERT creates an employee. It asks first, in words that name what it does, and for a hire date when the offer
// carries no start date (the server refuses without one).

export type OfferActionsApi = {
  setStatus: (tenantId: string, applicationId: string, offerId: string, status: string, declineReason?: string) => Promise<RecruitmentResult>;
  convert: (tenantId: string, applicationId: string, offerId: string, formData: FormData) => Promise<RecruitmentResult>;
};

export function OfferActions({ tenantId, applicationId, offerId, status, startOn, candidateName, canManage, canConvert, api }: {
  tenantId: string;
  applicationId: string;
  offerId: string;
  status: string;
  /** The offer's start date, which the server uses as the hire date when none is given. */
  startOn: string | null;
  candidateName: string;
  canManage: boolean;
  canConvert: boolean;
  api: OfferActionsApi;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [panel, setPanel] = useState<null | "convert" | StatusMove>(null);
  const [declineReason, setDeclineReason] = useState("");
  const [hireDate, setHireDate] = useState(startOn ? startOn.slice(0, 10) : "");
  const [workEmail, setWorkEmail] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);

  const moves = canManage ? offerMoves(status) : [];
  const showConvert = canConvert && status === "accepted";
  const convertNeedsDate = !startOn && !hireDate;

  function run(call: () => Promise<RecruitmentResult>) {
    startTransition(async () => {
      const res = await call();
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Done." });
        setPanel(null); setDeclineReason("");
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh(); // either way: after a refusal the offer may already be somewhere else ("offer is already converted")
    });
  }

  function convert() {
    const fd = new FormData();
    if (hireDate) fd.set("hireDate", hireDate);
    if (workEmail.trim()) fd.set("workEmail", workEmail.trim());
    run(() => api.convert(tenantId, applicationId, offerId, fd));
  }

  const none = moves.length === 0 && !showConvert;
  const move = panel && panel !== "convert" ? panel : null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {!none && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {moves.map((m) => (
            <button key={m.to} type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
              onClick={() => {
                setMsg(null);
                if (m.confirm || m.to === "declined") setPanel(move?.to === m.to ? null : m);
                else run(() => api.setStatus(tenantId, applicationId, offerId, m.to));
              }}>
              {m.label}
            </button>
          ))}
          {showConvert && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
              onClick={() => { setPanel(panel === "convert" ? null : "convert"); setMsg(null); }}>
              Convert to employee
            </button>
          )}
        </div>
      )}

      {move && (
        <div role="group" aria-label={`${move.label}`} style={panelStyle}>
          {move.confirm && <p style={textStyle}>{move.confirm}</p>}
          {move.to === "declined" && (
            <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
              <span>Reason they gave (optional)</span>
              <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} disabled={pending}
                style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }} />
            </label>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}
              onClick={() => run(() => api.setStatus(tenantId, applicationId, offerId, move.to, declineReason))}>
              {pending ? "Working…" : `Yes, ${move.label.toLowerCase()}`}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setPanel(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {panel === "convert" && showConvert && (
        <div role="group" aria-label={`Convert the offer to ${candidateName}`} style={panelStyle}>
          <p style={textStyle}>
            <strong>This creates an employee record for {candidateName}.</strong> They start with the status pending
            start, their pay is recorded from this offer, the application is marked hired and the requisition counts a
            seat as filled. It cannot be undone from here.
          </p>
          <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
            <span>Hire date{startOn ? "" : " (required: the offer has no start date)"}</span>
            <input type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} disabled={pending}
              style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }} />
          </label>
          <label style={{ display: "grid", gap: 4, font: "400 12px var(--font-body)" }}>
            <span>Work email (optional)</span>
            <input type="email" value={workEmail} onChange={(e) => setWorkEmail(e.target.value)} disabled={pending}
              style={{ font: "400 13px var(--font-body)", padding: 6, border: "1px solid var(--erp-line)", background: "transparent", color: "inherit" }} />
          </label>
          <p style={{ ...textStyle, color: "var(--erp-ink-60)" }}>Converting also needs a high-assurance sign-in.</p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || convertNeedsDate} onClick={convert}>
              {pending ? "Creating…" : "Create employee record"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setPanel(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {msg && <ResultMessage msg={msg} />}
      {status === "converted" && (
        <p style={textStyle}><Link href="/hr/people" style={{ color: "var(--erp-accent)" }}>Open People</Link> to see the employee record.</p>
      )}
    </div>
  );
}
