"use client";
// SCP-1k — the List tab: a table of the cycle's posts, and the two bulk actions of BFF §63.6.7.
//
//   Send to proofread   `send_to_proofread` on the SELECTED posts (the officer's step). "Send anyway" is not offered in bulk.
//   Approve all         `approve_copy` on EVERY one of this client's posts that is in `proofread` (the copywriter's step), whatever is selected.
//
// Each item runs on its own on the server, in its own transaction: one refusal never undoes another. The answer is shown PER ITEM, in words (the post's
// title, "done" or the sentence for the refusal), under a one-line summary. The gates here are hints only: the buttons are not hidden by role (the UI has
// no mirror of the officer or the copywriter), and a refused item says so. A post opens the post page (SCP-1e).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type CSSProperties } from "react";
import { bulkPostAction } from "@/lib/socialClientActions";
import { HealthChip } from "./HealthChip";
import { SimulatedMark } from "./SimulatedMark";
import {
  BULK_WORDS, bulkRefusalText, bulkSummary, formatWords, holderLabel, newUuid, phaseLabel, phaseStyle, postHref, statusLabel,
  type BulkAction, type BulkResult, type ClientPost,
} from "@/lib/socialClient";

interface Outcome { action: BulkAction; summary: string; lines: Array<{ postId: string; title: string; ok: boolean; text: string }> }

export function ClientPostList({ deptId, posts }: { deptId: string; posts: readonly ClientPost[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const helpId = useId();

  const byId = useMemo(() => new Map(posts.map((p) => [p.postId, p])), [posts]);
  const inProofread = posts.filter((p) => p.status === "proofread");
  const allPicked = posts.length > 0 && picked.size === posts.length;

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  function run(action: BulkAction, targets: readonly ClientPost[]) {
    setFailure(null);
    setOutcome(null);
    start(async () => {
      const r = await bulkPostAction(action, targets.map((p) => ({ postId: p.postId, expectedStatus: p.status, actionId: newUuid() })));
      if (!r.ok) { setFailure(r.message); return; }
      const lines = r.results.map((x: BulkResult) => ({
        postId: x.postId,
        title: byId.get(x.postId)?.title ?? "A post",
        ok: x.ok,
        text: x.ok ? (x.alreadyApplied ? "Already done." : `Done: ${BULK_WORDS[action].done}.`) : bulkRefusalText(x),
      }));
      setOutcome({ action, summary: bulkSummary(action, r.results), lines });
      if (r.results.some((x) => x.ok)) { setPicked(new Set()); router.refresh(); }
    });
  }

  if (posts.length === 0) return <p className="scp-note">No posts in this cycle yet.</p>;

  return (
    <section aria-label="Posts of this cycle">
      <div className="scp-list__bar">
        <button
          type="button" className="lux-btn lux-btn--sm" disabled={pending || picked.size === 0} aria-describedby={helpId}
          onClick={() => run("send_to_proofread", posts.filter((p) => picked.has(p.postId)))}
        >
          {BULK_WORDS.send_to_proofread.verb}{picked.size > 0 ? ` (${picked.size})` : ""}
        </button>
        <button
          type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending || inProofread.length === 0} aria-describedby={helpId}
          onClick={() => run("approve_copy", inProofread)}
        >
          {BULK_WORDS.approve_copy.verb}{inProofread.length > 0 ? ` (${inProofread.length} in proofread)` : ""}
        </button>
        <span id={helpId} className="scp-note" style={{ margin: 0 }}>
          Send to proofread is the officer&rsquo;s, on the posts you tick. Approve all is a copywriter&rsquo;s, on every post of this client in proofread. The server decides each one.
        </span>
      </div>
      {failure && <p className="scp-msg scp-msg--error" role="alert">{failure}</p>}
      <div className="scp-tablewrap">
        <table className="scp-table">
          <caption>{posts.length} {posts.length === 1 ? "post" : "posts"} in this cycle</caption>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox" aria-label="Select every post" checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(posts.map((p) => p.postId)))}
                />
              </th>
              <th scope="col">Post</th>
              <th scope="col">Format</th>
              <th scope="col">Status</th>
              <th scope="col">Phase</th>
              <th scope="col">With</th>
              <th scope="col">Health</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.postId}>
                <td>
                  <input type="checkbox" aria-label={`Select ${p.title}`} checked={picked.has(p.postId)} onChange={() => toggle(p.postId)} />
                </td>
                <td>
                  <Link href={postHref(deptId, p.postId)} className="scp-table__client">{p.title}</Link>
                  {p.simulated && <> <SimulatedMark /></>}
                  {p.isExtra && <span className="scp-table__sub">Extra post · outside the target</span>}
                  {!p.isExtra && p.format === "story" && <span className="scp-table__sub">Story · not counted</span>}
                </td>
                <td>{formatWords(p.format)}</td>
                <td>{statusLabel(p.status)}</td>
                <td>
                  <span className="scp-phasecell">
                    <span className="scp-phasecell__dot" style={phaseStyle(p.phase) as CSSProperties} aria-hidden="true" />
                    {phaseLabel(p.phase)}
                  </span>
                </td>
                <td>{holderLabel(p.holder)}</td>
                <td><HealthChip health={p.health} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {outcome && (
        <div role="status" aria-label="Result of the last bulk action">
          <p className="scp-msg" style={{ marginBottom: 0 }}>{BULK_WORDS[outcome.action].verb}: {outcome.summary}</p>
          <ul className="scp-list__results">
            {outcome.lines.map((l) => (
              <li key={l.postId} className={l.ok ? "scp-list__result--ok" : "scp-list__result--refused"}>
                <b>{l.title}</b>: {l.ok ? "" : "Refused. "}{l.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
