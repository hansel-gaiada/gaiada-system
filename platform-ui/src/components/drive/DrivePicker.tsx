"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loadPickerCredentialsAction, attachDriveFileAction } from "@/lib/driveActions";
import { openDrivePicker } from "@/lib/drivePicker";

// DW-6i (BFF §42.6): "Attach from Google Drive" on a PM task. The page renders this only when the Picker read said the person is
// connected and the feature is configured. On click it asks the server for a fresh Picker answer, loads Google's script (once,
// inside `drivePicker.ts`), opens the Picker, and posts each picked file to the attach route, then refreshes the page. The access
// token lives in this click's closure only: never in state, storage or a log.
export function DrivePicker({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pick() {
    setMsg(null);
    setError(null);
    startTransition(async () => {
      const creds = await loadPickerCredentialsAction();
      if (!creds.ok) return setError(creds.error);
      let ids: string[];
      try {
        ids = await openDrivePicker(creds.credentials);
      } catch (e) {
        return setError((e as Error)?.message || "Google's Picker could not be opened.");
      }
      if (ids.length === 0) return;
      const failures: string[] = [];
      let attached = 0;
      for (const id of ids) {
        const r = await attachDriveFileAction(taskId, id);
        if (r.ok) attached += 1;
        else if (!failures.includes(r.error)) failures.push(r.error);
      }
      if (attached > 0) setMsg(attached === 1 ? "Attached 1 file from Google Drive." : `Attached ${attached} files from Google Drive.`);
      if (failures.length > 0) setError(failures.join(" "));
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ alignSelf: "flex-start" }} disabled={pending} onClick={pick}>
        {pending ? "Working…" : "Attach from Google Drive"}
      </button>
      {msg && <p role="status" style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{msg}</p>}
      {error && <p role="alert" style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{error}</p>}
    </>
  );
}
