// SCP-1k — one post of a cycle as a card (the Plan and Stories grids): its title, format, status, who holds it and its health. The border is the
// phase's token; the phase, status and holder are written out, so colour is never the only signal. It links to the post page (SCP-1e), which opens as
// a drawer over the page.
import Link from "next/link";
import { HealthChip } from "./HealthChip";
import { SimulatedMark } from "./SimulatedMark";
import type { CSSProperties } from "react";
import { formatWords, holderLabel, phaseLabel, phaseStyle, statusLabel, type ClientPost } from "@/lib/socialClient";

export function PostCard({ post, href }: { post: ClientPost; href: string }) {
  return (
    <Link href={href} className="scp-pcard" style={phaseStyle(post.phase) as CSSProperties} data-phase={post.phase ?? ""}>
      <h4 className="scp-pcard__title">{post.title}</h4>
      <span className="scp-pcard__meta">
        <span>{formatWords(post.format)}</span>
        <span>{statusLabel(post.status)}</span>
        <span>{phaseLabel(post.phase)}</span>
        <span>With {holderLabel(post.holder).toLowerCase()}</span>
      </span>
      {post.isExtra && <span className="scp-pcard__flag">Extra post · outside the target</span>}
      {post.simulated && <SimulatedMark />}
      {post.health && <HealthChip health={post.health} />}
    </Link>
  );
}
