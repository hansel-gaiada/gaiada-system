"use client";
// DW-5b — edit the shared campaign's budget, currency, lead department and dates (`PATCH campaigns/:id`, contract
// §31.4). Offered to holders of `agency.campaign.manage`; the server (Cerbos `agency_campaign` update, then the money
// rules of §31.3) decides, and a refusal is shown as a sentence with the server's own figures.
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import { majorText, parseCurrencyInput, parseMoneyInput } from "@/lib/campaigns";
import { updateCampaignAction, type CampaignPatch } from "@/lib/campaignActions";
import "@/components/forms/forms.css";
import "./campaigns.css";

const NO_LEAD = "__none";

export function CampaignEditor({
  campaignId, budgetMinor, currency, leadUnitId, leadUnitName, startsOn, endsOn, departments,
}: {
  campaignId: string;
  budgetMinor: number | null;
  currency: string | null;
  leadUnitId: string | null;
  leadUnitName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  departments: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The current lead stays selectable even when it is not in the department list (it has left the org chart).
  const leadOptions = [
    { value: NO_LEAD, label: "Office of the GM (or the company)" },
    ...(leadUnitId && !departments.some((d) => d.id === leadUnitId)
      ? [{ value: leadUnitId, label: leadUnitName ?? "A department that is no longer in the org chart" }]
      : []),
    ...departments.map((d) => ({ value: d.id, label: d.name })),
  ];

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const cur = parseCurrencyInput(String(fd.get("currency") ?? ""));
    if (!cur.ok) return setError(cur.error);
    const bud = parseMoneyInput(String(fd.get("budget") ?? ""), cur.currency ?? currency);
    if (!bud.ok) return setError(bud.error);
    if (bud.minor !== null && cur.currency === null) return setError("Enter a currency for the budget.");

    const patch: CampaignPatch = {};
    if (bud.minor !== budgetMinor) patch.budgetMinor = bud.minor;
    if (cur.currency !== currency) patch.currency = cur.currency;
    const leadRaw = String(fd.get("leadUnitId") ?? "");
    const lead = leadRaw === NO_LEAD || leadRaw === "" ? null : leadRaw;
    if (lead !== leadUnitId) patch.leadUnitId = lead;
    const start = String(fd.get("startsOn") ?? "") || null;
    if (start !== startsOn) patch.startsOn = start;
    const end = String(fd.get("endsOn") ?? "") || null;
    if (end !== endsOn) patch.endsOn = end;
    if (Object.keys(patch).length === 0) {
      setOpen(false);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await updateCampaignAction(campaignId, patch, currency);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div className="cmp-actions">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Edit budget, lead and dates</Button>
      </div>
    );
  }
  return (
    <form className="cmp-form" onSubmit={submit} aria-label="Edit the campaign's budget, lead and dates">
      <div className="cmp-form__row">
        <Field
          name="budget" label="Budget" type="text" defaultValue={majorText(budgetMinor, currency)} placeholder="No budget"
          hint="In the currency's main unit, for example 12500.00. It cannot go below what the parts hold."
        />
        <Field
          name="currency" label="Currency" type="text" defaultValue={currency ?? ""} placeholder="USD"
          hint="Three letters. It cannot change while parts hold allocations."
        />
        <Field name="leadUnitId" label="Lead department" type="select" defaultValue={leadUnitId ?? NO_LEAD} optionItems={leadOptions} placeholder="Office of the GM (or the company)" />
      </div>
      <div className="cmp-form__row">
        <Field name="startsOn" label="Starts" type="date" defaultValue={startsOn ?? ""} />
        <Field name="endsOn" label="Ends" type="date" defaultValue={endsOn ?? ""} />
      </div>
      {error && <p className="cmp-error" role="alert">{error}</p>}
      <div className="cmp-actions">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save campaign"}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setError(null); }} disabled={pending}>Cancel</Button>
      </div>
    </form>
  );
}
