"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { RecruitmentResult } from "@/lib/hrRecruitmentActions";
import { EMPLOYMENT_TYPES, WORK_MODES } from "@/lib/hrRecruitment";
import { ResultMessage, fullRow, dimStyle } from "./RecruitmentBits";
import "@/components/forms/forms.css";

export type PersonOption = { userId: string; name: string };

/** The requisition as the list read it. The description and contract length are not in the list, so an edit leaves them alone when blank. */
export type RequisitionInitial = {
  title: string; openings: number; filled: number; employmentType: string; location: string | null; workMode: string | null;
  salaryMin: string | null; salaryMax: string | null; targetStartOn: string | null;
  hiringManagerUserId: string | null; recruiterUserId: string | null;
};

function RequisitionFields({ people, initial }: { people: PersonOption[]; initial?: RequisitionInitial }) {
  const editing = !!initial;
  const personItems = people.map((p) => ({ value: p.userId, label: p.name }));
  return (
    <>
      <Field name="title" label="Title" required={!editing} defaultValue={initial?.title} />
      <Field name="openings" label="Openings" type="number" defaultValue={initial?.openings ?? 1}
        hint={initial ? `${initial.filled} already filled; the server will not accept fewer` : "How many people to hire"} />
      <Field name="employmentType" label="Employment type" type="select" options={[...EMPLOYMENT_TYPES]}
        defaultValue={initial?.employmentType ?? "permanent"} placeholder="Permanent (default)" />
      <Field name="workMode" label="Work mode" type="select" options={[...WORK_MODES]} defaultValue={initial?.workMode ?? ""} placeholder="Not set" />
      <Field name="location" label="Location" defaultValue={initial?.location ?? ""} />
      <Field name="targetStartOn" label="Target start" type="date" defaultValue={initial?.targetStartOn?.slice(0, 10) ?? ""} />
      <Field name="salaryMin" label="Salary minimum" type="number" defaultValue={initial?.salaryMin ?? ""} />
      <Field name="salaryMax" label="Salary maximum" type="number" defaultValue={initial?.salaryMax ?? ""}
        hint="The approved ceiling: the server refuses an offer above it" />
      {people.length > 0 && (
        <>
          <Field name="hiringManagerUserId" label="Hiring manager" type="select" optionItems={personItems}
            defaultValue={initial?.hiringManagerUserId ?? ""} placeholder="None" hint="Can see and run this pipeline" />
          <Field name="recruiterUserId" label="Recruiter" type="select" optionItems={personItems}
            defaultValue={initial?.recruiterUserId ?? ""} placeholder="None" />
        </>
      )}
      <div style={fullRow}>
        <Field name="description" label="Description" type="textarea"
          hint={editing ? "Leave blank to keep the current description" : undefined} />
      </div>
    </>
  );
}

// "New requisition" (DW-7f-2). Creates a DRAFT; submitting it for approval is a separate step on the
// requisition. The server's words are shown as sent (duplicate reference, salary range).
export function RequisitionForm({ create, companyId, defaultCurrency, people }: {
  create: (formData: FormData) => Promise<RecruitmentResult>;
  companyId: string;
  defaultCurrency: string;
  people: PersonOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await create(formData);
      if (res.ok) { setMsg({ ok: true, text: res.notice ?? "Requisition created." }); setOpen(false); }
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <div>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => { setOpen(true); setMsg(null); }}>
            New requisition
          </button>
        </div>
        {msg && <ResultMessage msg={msg} />}
      </div>
    );
  }

  return (
    <Card title="New requisition" style={{ marginBottom: 22 }}>
      <form action={onSubmit} className="lux-form-grid" aria-label="New requisition">
        <input type="hidden" name="companyId" value={companyId} />
        <Field name="reference" label="Reference" required hint="Must be unique, e.g. REQ-2026-014" />
        <RequisitionFields people={people} />
        <Field name="currency" label="Currency" defaultValue={defaultCurrency} hint="3-letter code" />
        <p style={{ margin: 0, ...fullRow, ...dimStyle }}>Created as a draft. It needs approval before it opens.</p>
        {msg && !msg.ok && <div style={fullRow}><ResultMessage msg={msg} /></div>}
        <div style={{ ...fullRow, display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Creating…" : "Create draft requisition"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            onClick={() => { setOpen(false); setMsg(null); }}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

// Edit a requisition's details. Only the fields filled in are sent, so a field cannot be cleared from here.
export function RequisitionEditForm({ update, tenantId, requisitionId, initial, people, onDone }: {
  update: (tenantId: string, requisitionId: string, formData: FormData) => Promise<RecruitmentResult>;
  tenantId: string;
  requisitionId: string;
  initial: RequisitionInitial;
  people: PersonOption[];
  onDone?: (msg: { ok: boolean; text: string }) => void;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await update(tenantId, requisitionId, formData);
      if (res.ok) onDone?.({ ok: true, text: res.notice ?? "Requisition updated." });
      else setMsg({ ok: false, text: res.error ?? "The server refused this without giving a reason." });
      router.refresh();
    });
  };

  return (
    <form action={onSubmit} className="lux-form-grid" aria-label="Edit requisition">
      <RequisitionFields people={people} initial={initial} />
      {msg && <div style={fullRow}><ResultMessage msg={msg} /></div>}
      <div style={{ ...fullRow, display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => onDone?.({ ok: true, text: "" })}>
          Close
        </button>
      </div>
    </form>
  );
}
