"use client";
import { useCallback, useState } from "react";
import type { PortalSocialPost } from "@/lib/portalSocial";
import { PortalSocialPostCard } from "./PortalSocialPostCard";

// SCP-2 (BFF §63.9) — one post on its own page (`/portal/social/[postId]`): the same card and the same controls as the list, with every note from our team
// and each network's own wording. It keeps the new version of the post when the server says it changed while the client looked (`content_changed`), exactly
// as the list does.
export function PortalSocialPostView({ post, tenant }: { post: PortalSocialPost; tenant: string }) {
  const [reloaded, setReloaded] = useState<PortalSocialPost | null>(null);
  const onReloaded = useCallback((p: PortalSocialPost) => setReloaded(p), []);
  // the newer of the two: the reloaded copy wins only while the page's own copy is the stale one
  const current = reloaded && reloaded.reviewHash !== post.reviewHash ? reloaded : post;
  return <PortalSocialPostCard post={current} tenant={tenant} onReloaded={onReloaded} detail headingLevel={2} />;
}
