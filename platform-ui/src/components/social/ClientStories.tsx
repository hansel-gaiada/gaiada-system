// SCP-1k — the Stories tab: the cycle's story-format posts. They are not counted toward the monthly target (plan §4.4).
import { PostCard } from "./PostCard";
import { isStory, postHref, type ClientPost } from "@/lib/socialClient";

export function ClientStories({ deptId, posts }: { deptId: string; posts: readonly ClientPost[] }) {
  const stories = posts.filter(isStory);
  return (
    <section aria-label="Stories">
      <p className="scp-lede">Stories are not counted toward the monthly target. An extra post that is a story is listed with the extra posts on the Plan tab.</p>
      {stories.length === 0 ? (
        <p className="scp-note">No stories in this cycle yet.</p>
      ) : (
        <ul className="scp-plan__grid">{stories.map((p) => <li key={p.postId}><PostCard post={p} href={postHref(deptId, p.postId)} /></li>)}</ul>
      )}
    </section>
  );
}
