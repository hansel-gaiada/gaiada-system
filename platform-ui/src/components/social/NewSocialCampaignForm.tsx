"use client";
// DW-5b — create a social campaign on the Social campaigns screen, through the existing `createCampaign` action
// (`lib/socialActions.ts`). A social campaign belongs to an engagement, so the engagement is chosen here.
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import { createCampaign } from "@/lib/socialActions";
import "@/components/forms/forms.css";
import "@/components/agency/campaigns.css";

export function NewSocialCampaignForm({
  tenantId, engagements,
}: {
  tenantId: string;
  engagements: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const engagementId = String(fd.get("engagementId") ?? "");
    const name = String(fd.get("name") ?? "").trim();
    const goal = String(fd.get("goal") ?? "").trim();
    if (!engagementId) return setError("Choose the engagement this campaign belongs to.");
    if (!name) return setError("Name the campaign first.");
    setError(null);
    startTransition(async () => {
      const res = await createCampaign(tenantId, { engagementId, name, ...(goal ? { goal } : {}) });
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div className="cmp-actions">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>New social campaign</Button>
      </div>
    );
  }
  return (
    <form className="cmp-form" onSubmit={submit} aria-label="New social campaign">
      <div className="cmp-form__row">
        <Field name="engagementId" label="Engagement" type="select" required placeholder="Choose an engagement" optionItems={engagements.map((x) => ({ value: x.id, label: x.name }))} />
        <Field name="name" label="Name" type="text" required />
      </div>
      <Field name="goal" label="Goal" type="textarea" hint="Optional. Plain text." />
      {error && <p className="cmp-error" role="alert">{error}</p>}
      <div className="cmp-actions">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Creating…" : "Create campaign"}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setError(null); }} disabled={pending}>Cancel</Button>
      </div>
    </form>
  );
}
