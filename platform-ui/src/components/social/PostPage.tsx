"use client";
// SCP-1e to 1j, 1l (BFF §63.6, §63.8, §63.17; plan §8 rows 1e to 1l) — the Social Media post page, one body for two presentations: the full page at
// `{D}/posts/[postId]` and the drawer over any list (`@drawer/(.)departments/[deptId]/posts/[postId]`, the intercepting route of the PM task drawer).
//
// IT DRAWS THE READ (`GET posts/:postId/pipeline`) and nothing else it decides: the image and its designs, the status chip, the eight steps, the health, the Post and
// Creative brief tabs, the copy edit log, the comments (with pins on the image) and the activity, and the action bar the read's `actions[]` drive. Every write answers
// the post as the server reads it after the write, which replaces what is shown; a refusal is shown in words. UI gating is cosmetic: the server decides each write.
//
// COMMENTS are the shared thread in its social mode (`CommentThread`'s `social` prop). A client-visible comment is offered only when the read's own `actions[]` say the
// viewer holds `record_client` on the post (`canWriteClientComment`). A pin sits on a stored design (the file `final_approve` makes of it); before that the page says
// pins come later rather than offering one the server would refuse.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CommentThread } from "@/components/pm/CommentThread";
import { HealthChip } from "@/components/social/HealthChip";
import { PinOverlay, pinsFromComments } from "@/components/social/PinOverlay";
import { PostActionBar } from "@/components/social/PostActionBar";
import { ClientDecisionLine, ClientLink } from "@/components/social/PostClient";
import { PostDesigns } from "@/components/social/PostDesigns";
import { PostFields } from "@/components/social/PostFields";
import { Activity, CopyLog } from "@/components/social/PostLog";
import { PostMetricsSection } from "@/components/social/PostMetrics";
import { PostStepper } from "@/components/social/PostStepper";
import { postEntityComment } from "@/lib/collabActions";
import { formatDate, formatDateTime } from "@/lib/format";
import type { Comment, CommentAnchor } from "@/lib/pm";
import type { PostMetrics } from "@/lib/socialMetrics";
import { WAITING_ON_LABEL, blockerLines, canWriteClientComment, networkLabel, phaseText, postImage, statusChipText, statusLabel, type AssetChoice, type PipelinePost } from "@/lib/socialPipeline";
import type { WriteResult } from "@/lib/socialPipelineActions";
import "@/components/social/cycles.css";
import "@/components/social/post-page.css";

export interface PostPageProps {
  deptId: string;
  post: PipelinePost;
  /** The post's thread, or null when it could not be read (the page says so instead of showing an empty thread). */
  comments: Comment[] | null;
  /** The Asset Library's latest versions for the designer's picker; null when it could not be read. */
  assets: AssetChoice[] | null;
  /** SCP-3c: a live post's metrics (BFF §63.10). `undefined` when the post is not live; `null` when they could not be read (the block says so). */
  metrics?: PostMetrics | null;
  /** The signed-in person: the client's officer is offered the Enter metrics form. */
  viewerId?: string | null;
  /** DEMO_MODE: no bytes are stored, so the image is the reference image the demo store holds. */
  demo?: boolean;
  chrome?: "page" | "drawer";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string): string => { const x = /^(\d{4})-(\d{2})$/.exec(m); return x ? `${MONTHS[Number(x[2]) - 1] ?? x[2]} ${x[1]}` : m; };

interface Notice { kind: "ok" | "error"; text: string; lines: string[] }

export function PostPage({ deptId, post: initial, comments, assets, metrics, viewerId, demo = false, chrome = "page" }: PostPageProps) {
  const router = useRouter();
  const [post, setPost] = useState(initial);
  const [gone, setGone] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [placing, setPlacing] = useState(false);
  const [pending, setPending] = useState<CommentAnchor | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // A fresh read from the server (after `router.refresh()`) replaces what a write showed: the server's copy is the truth.
  useEffect(() => { setPost(initial); }, [initial]);

  function onResult(r: WriteResult, label: string) {
    if (!r.ok) {
      setNotice({ kind: "error", text: r.message, lines: blockerLines(r.refusal) });
      if (r.refusal.error === "status_changed") router.refresh();
      return;
    }
    const moved = r.applied && r.applied.to && r.applied.from !== r.applied.to && statusLabel(r.applied.to) !== r.applied.to ? ` Now at ${statusLabel(r.applied.to)}.` : "";
    setNotice({
      kind: "ok",
      text: r.alreadyApplied ? "That step was already done." : `${label}.${moved}`,
      lines: r.warnings,
    });
    if (r.post) setPost(r.post); else setGone(true);
    router.refresh();
  }

  if (gone) {
    return (
      <div className={`scp-post scp-post--${chrome}`}>
        <p className="scp-post__banner scp-post__banner--ok" role="status">{notice?.text ?? "Done."} This post no longer appears in any list.</p>
        <p><Link href={`/departments/${deptId}`} className="scp-link">Back to the department</Link></p>
      </div>
    );
  }

  const image = postImage(post, { demo });
  const pins = comments ? pinsFromComments(comments) : [];
  const pinnable = !!image?.fileId;
  const Title = chrome === "page" ? "h1" : "h2";
  const changed = post.change;
  const approved = post.approvedSchedule;

  return (
    <div className={`scp-post scp-post--${chrome}`}>
      <header className="scp-post__head">
        <Title className="scp-post__title">{post.title || "Untitled post"}</Title>
        <div className="scp-post__chips">
          <span className={`scp-chip${post.pipelineStatus === "changes" ? " scp-chip--changes" : post.pipelineStatus === "blocked" ? " scp-chip--blocked" : ""}`}>{statusChipText(post)}</span>
          {post.phase && <span className="scp-chip scp-chip--phase">{phaseText(post.phase)}</span>}
          <HealthChip health={post.health} />
          {post.simulated && <span className="scp-chip scp-chip--sim">SIMULATED</span>}
          {post.isExtra && <span className="scp-chip scp-chip--phase">Extra post</span>}
        </div>
        <div className="scp-post__meta">
          <span>{post.clientName}</span>
          {post.cycleMonth && <span>{monthLabel(post.cycleMonth)}</span>}
          {post.holder.label && <span>With: {post.holder.label}</span>}
          {post.officer && <span>Officer: {post.officer.name}</span>}
          <Link href={`/departments/${deptId}/composer/${post.id}`}>Open in the Composer</Link>
        </div>
      </header>

      <PostStepper post={post} />

      {notice && (
        <div className={`scp-post__banner scp-post__banner--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
          {notice.lines.length > 0 && <ul>{notice.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        </div>
      )}
      {post.archivedAt && <p className="scp-post__banner">This post is archived and cannot change.</p>}
      {changed && (
        <p className="scp-post__banner scp-post__banner--changes">
          <strong>{statusChipText(post)}.</strong> {changed.note ?? ""}
          {post.changedOnly && " The client asked for a copy change: after it is fixed, only the changed text is checked, and the post goes straight back to the client."}
        </p>
      )}
      {post.block && (
        <p className="scp-post__banner scp-post__banner--blocked">
          <strong>Blocked, waiting on {(WAITING_ON_LABEL[post.block.waitingOn] ?? post.block.waitingOn).toLowerCase()}.</strong> {post.block.reason}
          {post.block.at ? ` Since ${formatDate(post.block.at)}.` : ""} Resolving it returns the post to {statusLabel(post.block.from).toLowerCase()}.
        </p>
      )}
      {approved?.scheduledAt && (post.pipelineStatus === "approved" || post.pipelineStatus === "scheduled") && (
        <p className="scp-post__banner">
          The client approved {formatDateTime(approved.scheduledAt)} on {approved.placement.map(networkLabel).join(", ") || "no network"}
          {post.scheduleVia ? `, scheduled ${post.scheduleVia === "publisher" ? "through the publisher" : "by hand"}` : ""}. A different date or placement is Reschedule, and the client is asked again.
        </p>
      )}
      <ClientDecisionLine decision={post.clientDecision} />
      {post.pipelineStatus === "client" && !post.archivedAt && <ClientLink postId={post.id} title={post.title} />}
      {post.pipelineStatus === "live" && post.liveUrl && (
        <p className="scp-post__banner scp-post__banner--ok">Live{post.wentLiveAt ? ` since ${formatDateTime(post.wentLiveAt)}` : ""}: <a href={post.liveUrl} target="_blank" rel="noopener noreferrer">{post.liveUrl}</a></p>
      )}
      {post.skippedChecks.length > 0 && (
        <div className="scp-post__banner">
          <strong>Sent with failed checks.</strong>
          <ul>
            {post.skippedChecks.map((s, i) => (
              <li key={i}>{s.codes.map((c) => c.replace(/_/g, " ")).join(", ")}: &ldquo;{s.reason}&rdquo;{s.by ? ` (${s.by.name}, ${formatDate(s.at)})` : ""}</li>
            ))}
          </ul>
        </div>
      )}

      <PostActionBar post={post} image={image} onResult={onResult} />

      <div className="scp-post__grid">
        <div className="scp-post__media">
          {image ? (
            pinnable ? (
              <PinOverlay
                src={image.src} alt={image.alt} fileId={image.fileId!} pins={pins} placing={placing} selectedId={selected}
                onPlace={(a) => { setPending({ x: a.x, y: a.y, fileId: a.fileId }); setPlacing(false); }}
                onCancelPlace={() => setPlacing(false)} onSelectPin={(p) => setSelected(p.id)}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image.src} alt={image.alt} style={{ maxWidth: "100%", height: "auto", display: "block" }} />
            )
          ) : (
            <div className="scp-post__empty-image">No image yet. A reference image or a design shows here.</div>
          )}
          {!pinnable && <p className="scp-field__hint" style={{ margin: 0 }}>Pins on the image come once the design is stored, when the final check sends the post to the client.</p>}
          <PostDesigns post={post} assets={assets} onResult={onResult} />
        </div>
        <div className="scp-post__main">
          <PostFields post={post} onResult={onResult} />
        </div>
      </div>

      <PostMetricsSection post={post} metrics={metrics} viewerId={viewerId} onSaved={() => router.refresh()} />

      <section aria-labelledby="scp-post-copylog">
        <h3 className="scp-post__section-title" id="scp-post-copylog">Copy edit log</h3>
        <CopyLog post={post} />
      </section>

      <section aria-labelledby="scp-post-comments">
        <h3 className="scp-post__section-title" id="scp-post-comments">Comments</h3>
        {comments === null ? (
          <p className="scp-note" role="status" style={{ margin: 0 }}>The comments could not be read, so they are not shown here. This is not a statement that there are none.</p>
        ) : (
          <CommentThread
            comments={comments}
            post={postEntityComment.bind(null, "social_post", post.id)}
            social={{
              canWriteClient: canWriteClientComment(post),
              pendingAnchor: pending,
              onClearPendingAnchor: () => setPending(null),
              onStartPin: pinnable ? () => setPlacing(true) : undefined,
              onSelectPin: (id) => setSelected(id),
            }}
          />
        )}
        {post.variants.length > 0 && (
          <p className="scp-field__hint" style={{ margin: "8px 0 0" }}>
            {`Client review: ${post.variants.map((v) => `${networkLabel(v.network)} ${v.reviewStatus.replace(/_/g, " ") || "not asked yet"}`).join(", ")}.`}
          </p>
        )}
      </section>

      <section aria-labelledby="scp-post-activity">
        <h3 className="scp-post__section-title" id="scp-post-activity">Activity</h3>
        <Activity post={post} />
      </section>
    </div>
  );
}
