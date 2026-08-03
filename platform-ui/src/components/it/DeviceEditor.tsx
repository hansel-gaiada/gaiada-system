"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import "@/components/forms/forms.css";
import "./it.css";

// IT-02 — the edit/remove surface. 0019_it_devices.sql and lib/it.ts both promised "register/edit"
// but only register was ever built, so a typo'd device was permanent and nothing could be removed.
const KINDS = ["cctv", "printer", "server", "workstation", "network", "sensor", "iot", "other"];

type SaveResult = { ok: boolean; error?: string; id?: string };

export interface EditableDevice {
  id: string;
  name: string;
  kind: string;
  site?: string | null;
  network?: string | null;
  ip?: string | null;
  mac?: string | null;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  labels?: string[];
  discoverySource?: "manual" | "unifi";
}

interface Props {
  device: EditableDevice;
  update: (deviceId: string, formData: FormData) => Promise<SaveResult>;
  remove: (deviceId: string) => Promise<SaveResult>;
}

export function DeviceEditor({ device, update, remove }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A discovered row's ip/mac/hostname are network FACTS owned by the site collector, which rewrites
  // them every poll. The backend rejects editing them (400); hiding the inputs means the operator
  // never gets that error in the first place.
  const discovered = device.discoverySource === "unifi";

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await update(device.id, formData);
      if (res.ok) {
        setMsg(null);
        setOpen(false);
        router.refresh();
      } else {
        setMsg(res.error ?? "Couldn't save the device.");
      }
    });
  };

  const onDelete = () => {
    startTransition(async () => {
      const res = await remove(device.id);
      if (res.ok) router.push("/it/devices");
      else {
        setMsg(res.error ?? "Couldn't remove the device.");
        setConfirming(false);
      }
    });
  };

  if (!open) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>
          Edit
        </button>
        {confirming ? (
          <>
            <span style={{ font: "400 12px var(--font-body)", color: "var(--status-critical-fg)" }}>
              Remove this device?
            </span>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onDelete} disabled={pending}>
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
        {msg && (
          <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</span>
        )}
      </div>
    );
  }

  return (
    <Card title="Edit device" style={{ marginBottom: 20 }}>
      {discovered && (
        <p style={{ margin: "0 0 14px", font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
          This device is reported by network discovery. Its IP, MAC, hostname and status track the
          network and can’t be edited here — your changes to the fields below are kept and re-applied
          after every sync.
        </p>
      )}
      <form action={onSubmit} className="lux-form-grid">
        <Field name="name" label="Name" defaultValue={device.name} required />
        <Field name="kind" label="Type" type="select" options={KINDS} defaultValue={device.kind} required />
        <Field name="site" label="Site / location" defaultValue={device.site ?? ""} />
        <Field name="network" label="Network segment" defaultValue={device.network ?? ""} />
        {!discovered && <Field name="ip" label="IP address" defaultValue={device.ip ?? ""} />}
        {!discovered && <Field name="mac" label="MAC address" defaultValue={device.mac ?? ""} />}
        <Field name="vendor" label="Vendor" defaultValue={device.vendor ?? ""} />
        <Field name="model" label="Model" defaultValue={device.model ?? ""} />
        <Field name="firmware" label="Firmware" defaultValue={device.firmware ?? ""} />
        <Field name="labels" label="Labels (comma separated)" defaultValue={(device.labels ?? []).join(", ")} />
        {msg && <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setOpen(false); setMsg(null); }} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
