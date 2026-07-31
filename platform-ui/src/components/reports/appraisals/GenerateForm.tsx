"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import type { generateAppraisals } from "@/lib/appraisalActions";
import "@/components/forms/forms.css";

type GenerateFn = typeof generateAppraisals;

export interface RosterMember { userId: string; name: string; title: string | null }

function slugifyTitle(title: string | null): string {
  if (!title) return "";
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// TR-26 — HR's roster builder for `POST /appraisals/cycles/:id/generate`. appraisal-engine.ts's own
// header (point 2) is explicit that `roleKey` drives real cohort banding and free-text `users.title`
// is only a best-effort, NOT-guaranteed-to-match fallback — this form always prefills the
// slugified title so HR sees exactly what the server would fall back to, but leaves it editable so
// HR can supply the cycle's actual `role_weights` key instead of trusting the guess.
export function GenerateForm({ cycleId, members, generateAction }: {
  cycleId: string;
  members: RosterMember[];
  generateAction: GenerateFn;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [managerFor, setManagerFor] = useState<Record<string, string>>({});
  const [roleFor, setRoleFor] = useState<Record<string, string>>(() =>
    Object.fromEntries(members.map((m) => [m.userId, slugifyTitle(m.title)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ generated: number; skipped: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const readyCount = useMemo(
    () => [...selected].filter((id) => managerFor[id]).length,
    [selected, managerFor],
  );

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }

  function onGenerate() {
    setError(null);
    setResult(null);
    const subjects = [...selected]
      .filter((id) => managerFor[id])
      .map((id) => ({ subjectUserId: id, managerUserId: managerFor[id], roleKey: roleFor[id] || undefined }));
    if (subjects.length === 0) { setError("Select at least one subject and assign a manager for each."); return; }
    startTransition(async () => {
      const res = await generateAction(cycleId, subjects);
      if (!res.ok) { setError(res.error ?? "Couldn't generate — try again."); return; }
      setResult({ generated: res.result?.generated.length ?? 0, skipped: res.result?.skippedExisting.length ?? 0 });
      router.refresh();
    });
  }

  return (
    <Card title="Generate appraisals" style={{ marginBottom: 20 }}>
      <p style={{ margin: "0 0 10px", font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
        Generate freezes weights and cohort inputs from this cycle&rsquo;s sealed calendar periods — pick who
        this cycle applies to and who scores them.
      </p>
      <div className="lux-table" style={{ ["--lux-tcols" as string]: "24px 1fr 1fr 1fr" }}>
        <div className="lux-table__head">
          <span />
          <span>Subject</span>
          <span>Manager</span>
          <span>Role cohort key</span>
        </div>
        {members.map((m) => (
          <div className="lux-table__row" key={m.userId}>
            <input type="checkbox" checked={selected.has(m.userId)} onChange={() => toggle(m.userId)} aria-label={`Include ${m.name}`} />
            <span>{m.name}</span>
            <select
              className="lux-field__control"
              value={managerFor[m.userId] ?? ""}
              onChange={(e) => setManagerFor((prev) => ({ ...prev, [m.userId]: e.target.value }))}
              disabled={!selected.has(m.userId)}
            >
              <option value="">Select manager…</option>
              {members.filter((mm) => mm.userId !== m.userId).map((mm) => (
                <option key={mm.userId} value={mm.userId}>{mm.name}</option>
              ))}
            </select>
            <input
              type="text" className="lux-field__control" value={roleFor[m.userId] ?? ""}
              onChange={(e) => setRoleFor((prev) => ({ ...prev, [m.userId]: e.target.value }))}
              disabled={!selected.has(m.userId)}
            />
          </div>
        ))}
      </div>
      {error && <p style={{ margin: "10px 0 0", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{error}</p>}
      {result && (
        <p style={{ margin: "10px 0 0", font: "400 13px var(--font-body)", color: "var(--erp-ink-60)" }}>
          Generated {result.generated}, skipped {result.skipped} already-existing.
        </p>
      )}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onGenerate} disabled={pending || selected.size === 0}>
          {pending ? "Generating…" : `Generate (${readyCount} ready of ${selected.size} selected)`}
        </button>
      </div>
    </Card>
  );
}
