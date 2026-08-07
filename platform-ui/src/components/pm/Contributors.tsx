"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { EmptyNote } from "@/components/systems/EmptyNote";
import type { Contributor } from "@/lib/pm";
import "./pm.css";

interface Props {
  // undefined (not []) means the backend didn't send this field at all (a stale
  // deploy predating TR-02) — DISTINCT from a real empty list. Rendering `[]`
  // there as "No contributors" would read as "nobody contributed", which the
  // reporting program's owner-takes-all attribution makes actively misleading.
  contributors: Contributor[] | undefined;
  ownerId: string | undefined; // task.assignee?.responsibleId — the outcome-credited person
  ownerName: string | undefined;
  // Candidates for the "add" picker: tenant members not already a contributor.
  candidates: { id: string; name: string }[];
  canEdit: boolean;
  add: (userId: string) => Promise<{ ok: boolean; error?: string }>;
  remove: (userId: string) => Promise<{ ok: boolean }>;
}

// TR-32: surfaces TR-02's contributors[] + addContributor/removeContributor ops.
// Owner and contributor are rendered as two visually distinct groups (not one
// undifferentiated avatar list) — the reporting program credits the OWNER with
// the task's outcome and contributors only with their logged hours, so
// conflating them in the UI would misrepresent who's accountable.
export function Contributors({ contributors, ownerId, ownerName, candidates, canEdit, add, remove }: Props) {
  const router = useRouter();
  const [pick, setPick] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => { const r = await fn(); setMsg(r.ok ? null : r.error ?? "Failed."); router.refresh(); });

  const known = new Set((contributors ?? []).map((c) => c.userId));
  const options = candidates.filter((c) => c.id !== ownerId && !known.has(c.id));

  return (
    <div className="pm-contributors">
      <div className="pm-contributors__group">
        <span className="type-eyebrow pm-contributors__label">Owner · outcome-credited</span>
        {ownerId ? (
          <div className="pm-contributor pm-contributor--owner">
            <span className="pm-contributor__dot pm-contributor__dot--owner" aria-hidden />
            <Link href={`/people/${ownerId}`}>{ownerName ?? ownerId}</Link>
          </div>
        ) : (
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>No owner assigned.</p>
        )}
      </div>

      <div className="pm-contributors__group" style={{ marginTop: 14 }}>
        <span className="type-eyebrow pm-contributors__label">Contributors · hours only, no outcome credit</span>
        {contributors === undefined ? (
          <EmptyNote>Contributor data isn&apos;t available from this backend yet.</EmptyNote>
        ) : contributors.length === 0 ? (
          <EmptyNote>No contributors yet.</EmptyNote>
        ) : (
          contributors.map((c) => (
            <div className="pm-contributor" key={c.userId}>
              <span className="pm-contributor__dot" aria-hidden />
              <Link href={`/people/${c.userId}`}>{c.name}</Link>
              {canEdit && (
                <button
                  type="button"
                  className="lux-btn lux-btn--ghost lux-btn--sm"
                  disabled={pending}
                  onClick={() => run(() => remove(c.userId))}
                >
                  Remove
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {canEdit && contributors !== undefined && options.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
          <select className="lux-field__control" aria-label="Add a contributor" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1 }}>
            <option value="">Add a contributor…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button
            type="button"
            className="lux-btn lux-btn--ghost lux-btn--sm"
            disabled={pending || !pick}
            onClick={() => { const v = pick; setPick(""); run(() => add(v)); }}
          >
            Add
          </button>
        </div>
      )}
      {msg && <p style={{ margin: "8px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
    </div>
  );
}
