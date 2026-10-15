"use client";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { PolicyResult } from "@/lib/hrPolicyActions";
import { ResultMessage, fullRow, dimStyle } from "./RecruitmentBits";
import "@/components/forms/forms.css";

// The shell the review and policy write forms share (DW-7f-4, DW-7f-5): closed until opened, sends what the person typed
// to a server action, shows the SERVER's sentence as sent (a refusal in its own words, a success from its reply), and
// re-reads the page after every call, success or refusal. Nothing here decides: the page shows a form only to someone
// whose capability mirror says it is offered, and the server still decides.

export type PolicyFormApi = (tenantId: string, formData: FormData) => Promise<PolicyResult>;
export type Option = { value: string; label: string };

export function FormShell({ title, openLabel, submitLabel, pendingLabel, tenantId, action, children, intro, closeOnSuccess = false, secondary = false }: {
  title: string;
  openLabel: string;
  submitLabel: string;
  pendingLabel: string;
  tenantId: string;
  action: PolicyFormApi;
  children: ReactNode;
  intro?: ReactNode;
  closeOnSuccess?: boolean;
  /** A quieter open button, for an edit next to a primary action. */
  secondary?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await action(tenantId, formData);
      if (res.ok) {
        setMsg({ ok: true, text: res.notice ?? "Saved." });
        setFormKey((k) => k + 1); // a fresh form, ready for the next one
        if (closeOnSuccess) setOpen(false);
      } else {
        setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      }
      router.refresh(); // either way: after a refusal the view may be stale
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <div>
          <button type="button" className={`lux-btn ${secondary ? "lux-btn--ghost" : "lux-btn--solid"} lux-btn--sm`}
            onClick={() => { setOpen(true); setMsg(null); }}>
            {openLabel}
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <form key={formKey} action={onSubmit} className="lux-form-grid" aria-label={title}>
      {intro ? <p style={{ margin: 0, ...fullRow, ...dimStyle }}>{intro}</p> : null}
      {children}
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
          onClick={() => { setOpen(false); setMsg(null); }}>
          Close
        </button>
      </div>
    </form>
  );
}
