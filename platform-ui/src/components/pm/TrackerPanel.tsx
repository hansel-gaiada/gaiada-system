"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TrackerSuggestion } from "@/lib/pm";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "./pm.css";

interface Props {
  taskId: string;
  suggestions: TrackerSuggestion[];
  canAct: boolean;
  run: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  confirm: (id: string) => Promise<{ ok: boolean }>;
  dismiss: (id: string) => Promise<{ ok: boolean }>;
}

const KIND_LABEL: Record<string, string> = { progress: "Set progress", status: "Change status" };

export function TrackerPanel({ taskId, suggestions, canAct, run, confirm, dismiss }: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pendingSuggs = suggestions.filter((s) => s.status === "pending");
  const delivered = pendingSuggs[0]?.docs ?? suggestions[0]?.docs ?? [];

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) =>
    startTransition(async () => {
      const r = await fn();
      setMsg(r.ok ? okMsg ?? null : r.error ?? "Something went wrong.");
      router.refresh();
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
          The AI Tracker analyses this task, delivers relevant docs/info to the person in charge, and proposes updates for you to confirm.
        </p>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={() => act(() => run(taskId), "Tracker ran — see the timeline.")}>
          {pending ? "Running…" : "Run AI Tracker"}
        </button>
      </div>
      {msg && <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}

      {delivered.length > 0 && (
        <div>
          <span className="pm-sugg__label" style={{ display: "block", marginBottom: 6 }}>Delivered docs / info</span>
          <div className="pm-docs">
            {delivered.map((d) => <a key={d.ref} href="#" className="pm-doc" title={d.ref} onClick={(e) => e.preventDefault()}>{d.title}</a>)}
          </div>
        </div>
      )}

      {pendingSuggs.length === 0 ? (
        <EmptyNote>No pending suggestions. Run the tracker to generate updates.</EmptyNote>
      ) : (
        pendingSuggs.map((s) => (
          <div key={s.id} className="pm-sugg">
            <div className="pm-sugg__row">
              <span className="pm-sugg__label">{KIND_LABEL[s.kind] ?? s.kind}: <b>{s.proposed}</b></span>
              {canAct && (
                <span style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={() => act(() => confirm(s.id), "Applied.")}>Confirm</button>
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => act(() => dismiss(s.id))}>Dismiss</button>
                </span>
              )}
            </div>
            <span style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>{s.rationale}</span>
          </div>
        ))
      )}
    </div>
  );
}
