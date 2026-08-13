"use client";
// SMM-11 — edits a master post's own fields (title/brief/schedule/status) and offers the delete
// action. Per-network variant content lives in VariantCard.tsx, a separate concern.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { updatePost, deletePost } from "@/lib/socialActions";
import type { SocialPostDetail } from "@/lib/socialShared";

const STATUSES = [
  "idea", "draft", "in_review", "approved", "scheduled", "publishing",
  "published", "partially_published", "failed", "archived",
] as const;

export function PostFieldsForm({
  tenantId, deptId, post, canDelete,
}: {
  tenantId: string;
  deptId: string;
  post: SocialPostDetail;
  /** `social.post.delete` — Cerbos denies this to module_staff; the button is a UI hint, the
   *  backend re-checks regardless (defence in depth, never the boundary itself). */
  canDelete: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(post.title);
  const [brief, setBrief] = useState(post.brief ?? "");
  const [scheduledAt, setScheduledAt] = useState(post.scheduledAt ? post.scheduledAt.slice(0, 16) : "");
  const [status, setStatus] = useState(post.status);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await updatePost(tenantId, post.id, {
        title: title.trim() || undefined,
        brief: brief.trim(),
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        status,
      });
      if (!res.ok) { setError(res.error); return; }
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  function remove() {
    if (!confirm(`Delete "${post.title}"? This cannot be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deletePost(tenantId, post.id);
      if (!res.ok) { setError(res.error); return; }
      router.push(`/departments/${deptId}/composer`);
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Working title
        <input
          value={title} onChange={(e) => setTitle(e.target.value)} disabled={pending}
          style={{ display: "block", marginTop: 6, width: "100%", maxWidth: 480, font: "400 13px var(--font-body)", padding: "6px 8px" }}
        />
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Brief / angle
        <textarea
          value={brief} onChange={(e) => setBrief(e.target.value)} disabled={pending} rows={2}
          style={{ display: "block", marginTop: 6, width: "100%", maxWidth: 480, font: "400 13px var(--font-body)", padding: "6px 8px" }}
        />
      </label>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Scheduled for
          <input
            type="datetime-local" value={scheduledAt} disabled={pending}
            onChange={(e) => setScheduledAt(e.target.value)}
            style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "6px 8px" }}
          />
        </label>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Status
          <select
            value={status} disabled={pending}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "6px 8px" }}
          >
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Button variant="solid" size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
        {canDelete && (
          <Button variant="ghost" size="sm" onClick={remove} disabled={pending}>Delete post</Button>
        )}
        {savedAt && !error && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>Saved.</span>}
        {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{error}</span>}
      </div>
    </div>
  );
}
