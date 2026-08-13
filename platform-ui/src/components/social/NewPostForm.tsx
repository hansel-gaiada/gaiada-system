"use client";
// SMM-11 — the Composer's "new master post" affordance. Deliberately tiny (same rationale as
// search's NewCampaignForm.tsx/NewKeywordSetForm.tsx): a post is an idea + engagement + optional
// schedule; the per-network variant content is authored on the post's own detail page, once it
// has an id to attach variants to.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { createPost } from "@/lib/socialActions";
import type { SocialEngagement } from "@/lib/socialShared";

export function NewPostForm({ tenantId, deptId, engagements }: { tenantId: string; deptId: string; engagements: SocialEngagement[] }) {
  const router = useRouter();
  const [engagementId, setEngagementId] = useState(engagements[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (!engagementId) { setError("Pick an engagement first."); return; }
    if (!title.trim()) { setError("Give the post a working title."); return; }
    startTransition(async () => {
      const res = await createPost(tenantId, {
        engagementId,
        title: title.trim(),
        brief: brief.trim() || undefined,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        source: "human",
      });
      if (!res.ok || !res.id) {
        setError(!res.ok ? res.error : "Couldn't create the post.");
        return;
      }
      setTitle(""); setBrief(""); setScheduledAt("");
      router.push(`/departments/${deptId}/composer/${res.id}`);
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Engagement
        <select
          value={engagementId} disabled={pending}
          onChange={(e) => setEngagementId(e.target.value)}
          style={{ display: "block", marginTop: 6, minWidth: 160, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        >
          {engagements.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Working title
        <input
          value={title} onChange={(e) => setTitle(e.target.value)} disabled={pending}
          placeholder="Autumn launch teaser"
          style={{ display: "block", marginTop: 6, width: 220, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        />
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Brief / angle
        <input
          value={brief} onChange={(e) => setBrief(e.target.value)} disabled={pending}
          placeholder="Optional"
          style={{ display: "block", marginTop: 6, width: 220, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        />
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Scheduled for
        <input
          type="datetime-local" value={scheduledAt} disabled={pending}
          onChange={(e) => setScheduledAt(e.target.value)}
          style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        />
      </label>
      <Button variant="solid" size="sm" onClick={submit} disabled={pending || !engagements.length}>
        {pending ? "Creating…" : "New post"}
      </Button>
      {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{error}</span>}
    </div>
  );
}
