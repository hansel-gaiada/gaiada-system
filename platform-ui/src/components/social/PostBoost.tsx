"use client";
// SCP-4b (BFF §63.6.2, §63.11) — the Boost block of a LIVE Social Media post: the post's boost as a card with the actions its status and the person allow, and the "Boost this post" button
// that opens the request dialog (offered while the post has no open boost: a post has at most one, and the server refuses a second with `open_boost_exists`).
//
// IT DRAWS THE READ'S `boost` and decides nothing. `access` is what the server page could tell about the person (the post's officer, the HoD or GM seat for `canRun`; the budget read's
// `canRecord` for the two record actions): a person who cannot run a boost sees the button disabled with the reason, never absent. The server decides every write.
import { useId, useState } from "react";
import { BoostCard } from "@/components/social/BoostCard";
import { BoostRequestDialog } from "@/components/social/BoostRequestDialog";
import { BOOST_REFUSAL_WORDS, isOpenBoost } from "@/lib/socialBoosts";
import type { PipelinePost } from "@/lib/socialPipeline";
import "@/components/social/cycles.css";
import "@/components/social/post-page.css";
import "@/components/social/boosts.css";

export interface BoostAccess { canRun: boolean; canRecord: boolean }

export function PostBoostSection({ post, access, onChanged }: { post: PipelinePost; access: BoostAccess; onChanged?: () => void }) {
  const uid = useId();
  const [asking, setAsking] = useState(false);
  if (post.pipelineStatus !== "live" || post.archivedAt) return null;
  const boost = post.boost ?? null;
  const open = boost !== null && isOpenBoost(boost.status);
  const reason = `${uid}-why`;

  return (
    <section aria-labelledby={`${uid}-h`} className="scp-metrics">
      <h3 className="scp-post__section-title" id={`${uid}-h`}>Boost</h3>
      {boost ? (
        <BoostCard boost={boost} canRun={access.canRun} canRecord={access.canRecord} onChanged={onChanged} />
      ) : (
        <p className="scp-note" style={{ margin: 0 }}>This post has no boost. A boost records what the team runs in the network&apos;s own ads tools; nothing is bought from here.</p>
      )}
      {!open && (
        <div className="scp-row__buttons">
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setAsking(true)} disabled={!access.canRun} aria-describedby={access.canRun ? undefined : reason}>
            {boost ? "Boost again" : "Boost"}
          </button>
          {!access.canRun && <span id={reason} className="scp-field__hint">{BOOST_REFUSAL_WORDS.not_officer_or_approver}</span>}
        </div>
      )}
      {asking && <BoostRequestDialog postId={post.id} postTitle={post.title} onClose={() => setAsking(false)} onRequested={() => onChanged?.()} />}
    </section>
  );
}
