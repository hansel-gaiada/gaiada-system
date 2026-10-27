"use client";
// SCP-1m — the client page's create bar (plan §6.2 Create; BFF §63.6.1):
//
//   + New post              a post in this client's cycle: `POST cycles/:cycleId/posts` with a fresh `id`, the title, format, pillar, date and time, and the
//                           placement (the client's platforms). It starts `planned`, and counts toward the monthly target.
//   Extra post              the same, with `isExtra: true`: flagged, and outside the target (a client's event brief, for one).
//   New task                PM's own new-task flow (`/tasks/new`), already on the client's project when the engagement has one.
//   Ask Creatives for assets  the work-request form (§32) addressed to the Creatives department (`/requests/new?to=creatives`).
//
// Who may add a post is the cycle's officer and the four approvers (403 `not_officer_or_approver`): the button is not hidden by role, and a refusal is
// shown in words. The post needs a cycle: with none this month, the two post buttons are disabled and say why. The `id` is made once per form and kept
// across a retry, so a repeated request answers `created: false` instead of adding a second post.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { createClientPost } from "@/lib/socialClientActions";
import { ALLOCATION_FORMATS, FORMAT_LABEL, NETWORK_LABEL } from "@/lib/socialAllocation";
import { buildNewPost, newUuid, postHref, type NewPostDraft } from "@/lib/socialClient";

type Mode = "post" | "extra";
const EMPTY: Omit<NewPostDraft, "isExtra" | "placement"> = { title: "", format: "", pillar: "", scheduledLocal: "" };

export function ClientCreate({
  deptId, cycleId, platforms, pillars, projectId, askCreatives, openInitial,
}: {
  deptId: string;
  /** This month's cycle, or null: a post needs one. */
  cycleId: string | null;
  /** The client's platforms: the placement choices. */
  platforms: readonly string[];
  /** The brand book's content pillars, offered as suggestions for the pillar box. */
  pillars: readonly string[];
  /** The PM project the engagement is tied to, or null. */
  projectId: string | null;
  /** Whether the company has a Creatives department to ask (the registry's own rule for the link). */
  askCreatives: boolean;
  openInitial: Mode | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(cycleId ? openInitial : null);
  const [draft, setDraft] = useState(EMPTY);
  const [placement, setPlacement] = useState<string[]>([...platforms]);
  const [postId, setPostId] = useState(() => newUuid());
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [made, setMade] = useState<{ id: string; extra: boolean } | null>(null);
  const [pending, start] = useTransition();
  const uid = useId();
  const f = (k: string) => `${uid}-${k}`;
  const why = cycleId ? undefined : "This client has no cycle this month. A Social Media head sets its deadline in Settings first.";

  function open(m: Mode) {
    setMode(m === mode ? null : m);
    setError(null);
    setMade(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cycleId || !mode) return;
    setError(null);
    const built = buildNewPost({ ...draft, placement, isExtra: mode === "extra" }, postId);
    if (!built.ok) { setError({ field: built.field, message: built.message }); return; }
    start(async () => {
      const r = await createClientPost(cycleId, built.body);
      if (!r.ok) { setError({ field: r.field, message: r.message }); return; }
      setMade({ id: r.postId, extra: mode === "extra" });
      setDraft(EMPTY);
      setPlacement([...platforms]);
      setPostId(newUuid());
      setMode(null);
      router.refresh();
    });
  }

  const taskHref = projectId ? `/tasks/new?projectId=${encodeURIComponent(projectId)}` : "/tasks/new";
  return (
    <div className="scp-client">
      <div className="scp-create" role="group" aria-label="Create">
        <button type="button" className="lux-btn lux-btn--sm" disabled={!cycleId} title={why} aria-expanded={mode === "post"} onClick={() => open("post")}>
          + New post
        </button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={!cycleId} title={why} aria-expanded={mode === "extra"} onClick={() => open("extra")}>
          Extra post
        </button>
        <Link href={taskHref} className="lux-btn lux-btn--ghost lux-btn--sm">New task</Link>
        {askCreatives && <Link href="/requests/new?to=creatives" className="lux-btn lux-btn--ghost lux-btn--sm">Ask Creatives for assets</Link>}
      </div>
      {!cycleId && <p className="scp-note scp-note--reason">{why}</p>}
      {made && (
        <p className="scp-msg scp-msg--ok" role="status">
          {made.extra ? "Extra post added, outside the target." : "Post added to the plan."} <Link href={postHref(deptId, made.id)}>Open it</Link>
        </p>
      )}
      {mode && (
        <form className="scp-create__panel" onSubmit={submit} aria-label={mode === "extra" ? "New extra post" : "New post"}>
          <h3 className="scp-create__title">
            {mode === "extra" ? "Extra post" : "New post"}
            {mode === "extra" && <span className="scp-create__flag"> · outside the monthly target</span>}
          </h3>
          <div className="scp-fields">
            <label className="scp-field" htmlFor={f("title")}>
              Title
              <input id={f("title")} className="scp-input scp-input--wide" value={draft.title} maxLength={200} required onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="scp-field" htmlFor={f("format")}>
              Format
              <select id={f("format")} className="scp-input" value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value })}>
                <option value="">Not chosen yet</option>
                {ALLOCATION_FORMATS.map((x) => <option key={x} value={x}>{FORMAT_LABEL[x]}</option>)}
              </select>
            </label>
            <label className="scp-field" htmlFor={f("pillar")}>
              Pillar
              <input id={f("pillar")} className="scp-input" list={f("pillars")} value={draft.pillar} maxLength={60} onChange={(e) => setDraft({ ...draft, pillar: e.target.value })} />
              <datalist id={f("pillars")}>{pillars.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
            <label className="scp-field" htmlFor={f("at")}>
              Date and time
              <input id={f("at")} type="datetime-local" className="scp-input" value={draft.scheduledLocal} onChange={(e) => setDraft({ ...draft, scheduledLocal: e.target.value })} />
              <span className="scp-field__hint">Optional now. The client approves the date, time and placement with the post.</span>
            </label>
          </div>
          <fieldset className="scp-alloc__checks">
            <legend className="scp-field">Placement</legend>
            {platforms.length === 0 ? (
              <span className="scp-note" style={{ margin: 0 }}>This client has no platforms yet. A Social Media head sets them in Allocation; the post can be sent only once it has a placement.</span>
            ) : (
              platforms.map((n) => (
                <label key={n} className="scp-alloc__check">
                  <input
                    type="checkbox" checked={placement.includes(n)}
                    onChange={() => setPlacement((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]))}
                  />
                  {NETWORK_LABEL[n] ?? n}
                </label>
              ))
            )}
          </fieldset>
          {error && <p className="scp-msg scp-msg--error" role="alert">{error.message}</p>}
          <div className="scp-actions" style={{ margin: 0 }}>
            <button type="submit" className="lux-btn lux-btn--sm" disabled={pending}>{pending ? "Adding…" : mode === "extra" ? "Add extra post" : "Add post"}</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => open(mode)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
