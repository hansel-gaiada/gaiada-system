"use client";
import { useRef } from "react";
import { switchTenant } from "@/lib/tenant";

// A <select> inside a server-component <form action={serverAction}> only submits on an
// explicit submit event — there's no click on a <select>. This client wrapper submits the
// form as soon as the selection changes, keeping the actual switchTenant call a server action.
export function TenantSwitcher({ companies, current }: {
  companies: { id: string; name: string }[]; current: string | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={switchTenant} className="erp-company__form">
      <select
        name="tenantId"
        className="erp-company__select"
        defaultValue={current ?? undefined}
        aria-label="Active company"
        onChange={() => formRef.current?.requestSubmit()}
      >
        {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <noscript><button type="submit">Switch</button></noscript>
    </form>
  );
}
