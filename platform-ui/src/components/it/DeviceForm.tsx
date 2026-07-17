"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import "@/components/forms/forms.css";

// Device kinds mirror lib/it.ts DEVICE_KINDS (kept literal here so this client
// component doesn't import the server-only module).
const KINDS = ["cctv", "printer", "server", "workstation", "network", "sensor", "iot", "other"];

type SaveResult = { ok: boolean; error?: string; id?: string };
interface Props {
  register: (formData: FormData) => Promise<SaveResult>;
}

export function DeviceForm({ register }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await register(formData);
      if (res.ok) {
        setMsg(null);
        setOpen(false);
        router.refresh();
      } else {
        setMsg(res.error ?? "Couldn't register the device.");
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
        Register device
      </button>
    );
  }

  return (
    <Card title="Register a device" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid">
        <Field name="name" label="Name" required />
        <Field name="kind" label="Type" type="select" options={KINDS} required />
        <Field name="site" label="Site / location" />
        <Field name="network" label="Network segment" />
        <Field name="ip" label="IP address" />
        <Field name="vendor" label="Vendor" />
        <Field name="model" label="Model" />
        <Field name="mac" label="MAC address" />
        {msg && <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Registering…" : "Register"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(false); setMsg(null); }} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
