import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalSocialPost } from "@/lib/portal-data";
import { parseId } from "@/lib/portalSocial";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalSocialPostView } from "@/components/portal/social/PortalSocialPostView";
import "@/components/portal/social/portalSocial.css";

// SCP-2 (BFF §63.9) — one post on its own page: the same card and the same controls as the list, with every note from our team and each network's wording.
// The grid preview opens posts here.
//
// A post the contact cannot see (not their client's, or one that has not reached the client) is the server's 404 and is a 404 page here, never told apart
// from a post that does not exist (the existence-oracle rule of every portal detail page).
export default async function PortalSocialPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant || !parseId(postId)) notFound();

  const post = await getPortalSocialPost(userId, tenant, postId);
  if (!post) notFound();

  return (
    <>
      <PortalPageHead eyebrow="Your input" title="Review this post" lead="This is how the post will look. Approve it, or ask us to change it." />
      <p className="ps-older"><Link className="ps-link" href="/portal/social">All social posts</Link></p>
      <div className="ps-feed ps-feed--one">
        <PortalSocialPostView post={post} tenant={tenant} />
      </div>
    </>
  );
}
