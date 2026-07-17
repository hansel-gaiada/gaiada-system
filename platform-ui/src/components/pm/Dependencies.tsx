"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "./pm.css";

interface DepRef { id: string; title: string; status: string; done: boolean }
interface Option { id: string; title: string }
interface Props {
  current: DepRef[];
  options: Option[]; // candidate blockers (already excludes self + cycle-creating)
  canEdit: boolean;
  add: (blockerId: string) => Promise<{ ok: boolean; error?: string }>;
  remove: (blockerId: string) => Promise<{ ok: boolean }>;
}

// "Blocked by" list — the tasks that must finish before this one. `options` is
// pre-filtered server-side to avoid cycles.
export function Dependencies({ current, options, canEdit, add, remove }: Props) {
  const router = useRouter();
  const [pick, setPick] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => { const r = await fn(); setMsg(r.ok ? null : r.error ?? "Failed."); router.refresh(); });

  return (
    <div className="pm-deps">
      {current.length === 0 ? (
        <EmptyNote>No dependencies — this task isn&apos;t blocked by anything.</EmptyNote>
      ) : (
        current.map((d) => (
          <div className="pm-dep" key={d.id}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Link className="pm-dep__title" href={`/tasks/${d.id}`} style={{ textDecoration: "none" }}>{d.title}</Link>
              <StatusBadge label={d.status} />
            </span>
            {canEdit && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => run(() => remove(d.id))}>Remove</button>}
          </div>
        ))
      )}
      {canEdit && options.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
          <select className="lux-field__control" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1 }}>
            <option value="">Add a blocker…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending || !pick} onClick={() => { const v = pick; setPick(""); run(() => add(v)); }}>Add</button>
        </div>
      )}
      {msg && <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
    </div>
  );
}
