"use client";
// Calendar drag-to-reschedule (SMM-12). Split out of `calendar/page.tsx` (a server component,
// which cannot hold "use client" event handlers) as a NEW file — not on this ticket's original
// exact file list, but unavoidable: the interactive grid has to live somewhere, and folding drag
// handlers into the server page is not an option Next.js offers. Flagged in this ticket's final
// report as the one addition outside the listed files.
//
// Native HTML5 drag-and-drop only — `platform-ui/CLAUDE.md`'s hard constraint is FOUR runtime
// deps (next/react/react-dom/server-only), no state manager, no new library. No `useState`-based
// DnD kit, no draggable library: `draggable`, `onDragStart`, `onDragOver`, `onDrop` are all the
// browser already gives us.
//
// ── THE CONSEQUENCE THAT MUST BE VISIBLE BEFORE THE DROP COMMITS ───────────────────────────────
// A variant's `status === "approved"` is the live signal that it holds an unconsumed publish
// approval (`social.controller.ts`'s `updateVariant`: `approval_id` is stamped together with
// `status='approved'`, and ANY edit — including a reschedule, which rewrites `scheduled_at` and
// therefore the hashed args, D-15 — reverts it to `draft` and clears `approval_id` in the same
// statement). So "this post has an approved variant" is exactly the moment a drag-drop is about to
// throw an approval away, and the operator must be told THAT, in those words, before the drop is
// committed — not discover it afterwards as a UI toast, and not have it happen as a silent side
// effect of `updateVariant`'s existing (and correct) invalidation logic. `confirm()` is the same
// idiom `VariantCard.tsx`/`PostFieldsForm.tsx` already use for a destructive step; a bespoke modal
// component would be a second pattern for the same job.
//
// The roll-up `listPosts` returns (`SocialPostVariantSummary`) carries `status` but not `network`
// (lib/social.ts's own header names this gap) — so the warning names a COUNT of at-risk variants,
// not which network each is on. Naming the exact networks would need the full per-post detail read
// this list view deliberately avoids (no N+1). Flagged in the final report as a real, if minor,
// information gap rather than something this component can paper over.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { rescheduleVariants, type RescheduleVariantOutcome } from "@/lib/socialActions";
import { describeRefusal, type SocialPost } from "@/lib/socialShared";

export interface CalendarGridDay {
  key: string;
  dayNumber: number;
  inMonth: boolean;
}

export function CalendarGrid({
  tenantId, deptId, gridDays, byDay, unscheduled, canReschedule,
}: {
  tenantId: string;
  deptId: string;
  gridDays: CalendarGridDay[];
  byDay: Record<string, SocialPost[]>;
  unscheduled: SocialPost[];
  /** `social.manage` — the same capability the Composer's own "author/edit" affordance gates.
   *  Dragging IS an edit (it calls `updateVariant`/`updatePost`), so it rides the identical
   *  capability rather than inventing a `social.reschedule` key the catalog does not define. */
  canReschedule: boolean;
}) {
  const router = useRouter();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ title: string; outcomes: RescheduleVariantOutcome[]; error?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const allPosts = [...unscheduled, ...Object.values(byDay).flat()];
  const postById = new Map(allPosts.map((p) => [p.id, p]));

  function commit(post: SocialPost, dateKey: string) {
    const [y, m, d] = dateKey.split("-").map(Number);
    // Preserve the existing time-of-day when the post already had one; default to 09:00 local for
    // a post moving out of "unscheduled" for the first time.
    const prev = post.scheduledAt ? new Date(post.scheduledAt) : null;
    const next = new Date(y, m - 1, d, prev ? prev.getHours() : 9, prev ? prev.getMinutes() : 0, 0, 0);
    const variantIds = post.variants.map((v) => v.id);
    startTransition(async () => {
      const res = await rescheduleVariants(tenantId, post.id, next.toISOString(), variantIds);
      if (!res.ok) {
        setBanner({ title: `Couldn't reschedule "${post.title}"`, outcomes: [], error: res.error });
        return;
      }
      setBanner({ title: `Rescheduled "${post.title}"`, outcomes: res.variants });
      router.refresh();
    });
  }

  function handleDrop(dateKey: string) {
    setDragOverKey(null);
    if (!draggingId) return;
    const post = postById.get(draggingId);
    setDraggingId(null);
    if (!post) return;
    if (post.scheduledAt && dateKeyOf(post.scheduledAt) === dateKey) return; // dropped on its own day — no-op

    const approvedCount = post.variants.filter((v) => v.status === "approved").length;
    if (approvedCount > 0) {
      const plural = approvedCount === 1 ? "an existing approval" : `${approvedCount} existing approvals`;
      const ok = confirm(
        `"${post.title}" has ${approvedCount} approved variant${approvedCount === 1 ? "" : "s"}. ` +
        `Rescheduling changes the content the approval was granted against, so this will discard ${plural} — ` +
        `each affected variant drops back to draft and needs approving again before it can publish. Continue?`,
      );
      if (!ok) return;
    }
    commit(post, dateKey);
  }

  return (
    <div>
      {banner && (
        <div
          role="status"
          style={{
            marginBottom: 12, padding: "8px 12px", border: "0.5px solid var(--erp-hairline)",
            borderLeft: `3px solid ${banner.error ? "var(--status-critical-fg, #b3261e)" : "var(--status-caution-fg, #9a6700)"}`,
            background: "var(--tint-hover)", display: "flex", flexDirection: "column", gap: 4,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span style={{ font: "700 12px var(--font-body)", color: "var(--text-primary)" }}>{banner.title}</span>
            <button type="button" onClick={() => setBanner(null)} className="lux-btn lux-btn--ghost lux-btn--sm">Dismiss</button>
          </div>
          {banner.error && (
            <span style={{ font: "400 12px var(--font-body)", color: "var(--status-critical-fg, #b3261e)" }}>{banner.error}</span>
          )}
          {banner.outcomes.map((o) => (
            <span key={o.variantId} style={{ font: "400 12px var(--font-body)", color: o.ok ? "var(--erp-ink-60)" : "var(--status-critical-fg, #b3261e)" }}>
              {o.ok
                ? (o.approvalInvalidated ? "One variant moved — its approval no longer applies and needs re-approving." : "One variant moved.")
                : `One variant did not move: ${describeRefusal(o.error ?? "")}`}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, background: "var(--erp-hairline)", border: "0.5px solid var(--erp-hairline)" }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} style={{ background: "var(--surface-card)", padding: "6px 8px", font: "700 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
            {d}
          </div>
        ))}
        {gridDays.map(({ key, dayNumber, inMonth }) => {
          const dayPosts = byDay[key] ?? [];
          const isOver = dragOverKey === key;
          return (
            <div
              key={key}
              onDragOver={(e) => { if (canReschedule && draggingId) { e.preventDefault(); setDragOverKey(key); } }}
              onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
              onDrop={(e) => { e.preventDefault(); handleDrop(key); }}
              style={{
                background: isOver ? "var(--tint-hover)" : "var(--surface-card)", minHeight: 96, padding: 6,
                opacity: inMonth ? 1 : 0.4, display: "flex", flexDirection: "column", gap: 4,
                outline: isOver ? "1.5px dashed var(--erp-ink-60)" : "none", outlineOffset: -2,
              }}
            >
              <span style={{ font: "600 11px var(--font-body)", color: "var(--erp-ink-50)" }}>{dayNumber}</span>
              {dayPosts.map((p) => (
                <PostChip
                  key={p.id} post={p} deptId={deptId} draggable={canReschedule && !pending}
                  onDragStart={() => setDraggingId(p.id)} onDragEnd={() => setDraggingId(null)}
                />
              ))}
            </div>
          );
        })}
      </div>

      {unscheduled.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <span style={{ font: "700 11px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
            Unscheduled ({unscheduled.length}){canReschedule && " — drag onto a day to schedule"}
          </span>
          <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {unscheduled.map((p) => (
              <li key={p.id}>
                <PostChip
                  post={p} deptId={deptId} draggable={canReschedule && !pending} inline
                  onDragStart={() => setDraggingId(p.id)} onDragEnd={() => setDraggingId(null)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function dateKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function PostChip({
  post, deptId, draggable, inline, onDragStart, onDragEnd,
}: {
  post: SocialPost;
  deptId: string;
  draggable: boolean;
  inline?: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const approvedCount = post.variants.filter((v) => v.status === "approved").length;
  return (
    <Link
      href={`/departments/${deptId}/composer/${post.id}`}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", post.id); onDragStart(); }}
      onDragEnd={onDragEnd}
      title={approvedCount > 0 ? `${approvedCount} approved variant${approvedCount === 1 ? "" : "s"} — dragging discards the approval` : undefined}
      style={{
        display: "flex", ...(inline ? { gap: 10, alignItems: "center" } : { flexDirection: "column", gap: 2 }),
        textDecoration: "none", padding: "3px 5px", background: "var(--tint-hover)",
        border: "0.5px solid var(--erp-hairline-soft)", cursor: draggable ? "grab" : "default",
      }}
    >
      <span style={{ font: "600 11px var(--font-body)", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {post.title}
      </span>
      <span style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {post.variants.length === 0 ? (
          <StatusBadge label={post.status} />
        ) : (
          post.variants.map((v) => <StatusBadge key={v.id} label={v.status} />)
        )}
      </span>
    </Link>
  );
}
