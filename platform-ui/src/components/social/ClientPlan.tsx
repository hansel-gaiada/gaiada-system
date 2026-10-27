// SCP-1k — the Plan tab (plan §4.4): this cycle's counted posts fill the slots of the monthly target in order, empty slots follow up to the target, and the
// stories and extra posts are shown APART and never fill a slot. No target means no slots, and the page says so. Counted posts past the target are listed
// after the slots rather than hidden. An empty slot links to the New post form of the page.
import Link from "next/link";
import { PostCard } from "./PostCard";
import { clientHref, planSlots, postHref, type ClientPost } from "@/lib/socialClient";

export function ClientPlan({
  deptId, engagementId, posts, target, canAdd,
}: {
  deptId: string; engagementId: string; posts: readonly ClientPost[]; target: number | null; canAdd: boolean;
}) {
  const plan = planSlots(posts, target);
  return (
    <div className="scp-client">
      <section aria-label="Slots of the monthly target">
        <h3 className="scp-plan__sub">{target === null ? "Counted posts (no monthly target set)" : `The monthly target: ${target} ${target === 1 ? "post" : "posts"}`}</h3>
        {target === null && <p className="scp-note">No target is set for this client, so there are no slots to fill. A Social Media head sets it in Allocation.</p>}
        {target === 0 && <p className="scp-note">The target is 0, so every post here is beside it.</p>}
        <ul className="scp-plan__grid" aria-label="Counted posts and empty slots">
          {plan.filled.map((p) => (
            <li key={p.postId}><PostCard post={p} href={postHref(deptId, p.postId)} /></li>
          ))}
          {Array.from({ length: plan.empty }, (_, i) => (
            <li key={`slot-${i}`} className="scp-slot--empty" data-slot="empty">
              <span>Empty slot {plan.filled.length + i + 1} of {target}</span>
              {canAdd && <Link href={clientHref(deptId, engagementId, "plan", { new: "post" })}>+ New post</Link>}
            </li>
          ))}
        </ul>
      </section>
      {plan.over.length > 0 && (
        <section aria-label="Counted posts past the target">
          <h3 className="scp-plan__sub">Past the target ({plan.over.length})</h3>
          <ul className="scp-plan__grid">
            {plan.over.map((p) => <li key={p.postId}><PostCard post={p} href={postHref(deptId, p.postId)} /></li>)}
          </ul>
        </section>
      )}
      <section aria-label="Extra posts, outside the target">
        <h3 className="scp-plan__sub">Extra posts, outside the target ({plan.extras.length})</h3>
        {plan.extras.length === 0 ? (
          <p className="scp-note">No extra posts this cycle. An extra post, such as a client&rsquo;s event brief, never takes a slot.</p>
        ) : (
          <ul className="scp-plan__grid">{plan.extras.map((p) => <li key={p.postId}><PostCard post={p} href={postHref(deptId, p.postId)} /></li>)}</ul>
        )}
      </section>
      <section aria-label="Stories, not counted">
        <h3 className="scp-plan__sub">Stories, not counted ({plan.stories.length})</h3>
        <p className="scp-note">Stories are listed on the <Link href={clientHref(deptId, engagementId, "stories")}>Stories tab</Link> and never fill a slot.</p>
      </section>
    </div>
  );
}
