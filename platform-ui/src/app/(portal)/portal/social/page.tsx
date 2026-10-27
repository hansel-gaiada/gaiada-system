import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import {
  getPortalOverview, getPortalSocialPost, listPortalSocialReviews, listPortalSocialStories, listPortalSocialPosts,
} from "@/lib/portal-data";
import { parseCursor, parseId, parseMonth, parseTab, socialHref, tabForState } from "@/lib/portalSocial";
import { todayIsoInDisplayZone } from "@/lib/format";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalSocialCountsBar, PortalSocialFilters, PortalSocialTabs } from "@/components/portal/social/PortalSocialHeader";
import { PortalSocialView } from "@/components/portal/social/PortalSocialView";

// SCP-2 (BFF §63.9, plan SCP-2a) — "Social posts": the month's approval page. The client's own view of what they are being asked to approve, in the
// portal's look, with each post drawn as it will look on the network.
//
//   header   the counts (to approve, approved, changes asked), then the month switcher and, with more than one client, the client filter;
//   stories  the stories circle (a story opens full-screen with the same controls);
//   tabs     To review (default), Grid preview, Approved: links, `?tab=`;
//   list     a card per post, or the grid.
//
// THE WAY IN (SCP-2f, SCP-Q8): `/portal/social?post=<id>` is the link we send, shareable to WhatsApp. It passes through the portal sign-in (the
// sign-in returns to this exact URL, query included) and lands here: the tab that holds the post is chosen from the post's own state (a redirect, so
// the URL says where the post is), the post is scrolled to and focused, or, for a story, opened. A post the contact cannot see is a plain note above
// the list, never an error page: the link may be old, and the list below it is still theirs.
//
// A MONTH IS A FILTER, NOT A DEFAULT: with no `month` every month is listed, because a post waiting for the client is often next month's (a batch is
// delivered ahead of its cycle), and a default of "this month" would hide it. Reads and the page are the server's; the page only carries the choice.
// DEGRADE: the stories are a shortcut and are hidden when they cannot be read; the list never is: a failed read throws into the route's error boundary
// and is never shown as "nothing is waiting for you".
/** The client filter's choices. A failed read hides the filter (the page then lists every client): it is a convenience, not a claim about the posts. */
async function clientsOf(userId: string, tenant: string): Promise<Array<{ id: string; name: string }>> {
  try {
    return (await getPortalOverview(userId, tenant)).overview?.clients ?? [];
  } catch {
    return [];
  }
}

/** How many of the older per-variant post reviews still wait for the client, for the small "Older post reviews" link. A failed read shows no link; the list is untouched. */
async function olderPendingCount(userId: string, tenant: string): Promise<number> {
  try {
    return (await listPortalSocialReviews(userId, tenant, "pending")).reviews.length;
  } catch {
    return 0;
  }
}

export default async function PortalSocialPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const tab = parseTab(sp.tab);
  const month = parseMonth(sp.month);
  const clientId = parseId(sp.clientId);
  const cursor = parseCursor(sp.cursor);
  const post = parseId(sp.post);
  const q = { tab, month, clientId };

  const [res, stories, clients, olderPending, target] = await Promise.all([
    listPortalSocialPosts(userId, tenant, { tab, month, clientId, cursor }),
    cursor ? Promise.resolve(null) : listPortalSocialStories(userId, tenant, clientId),
    clientsOf(userId, tenant),
    olderPendingCount(userId, tenant),
    post ? getPortalSocialPost(userId, tenant, post) : Promise.resolve(null),
  ]);

  const head = <PortalPageHead eyebrow="Your input" title="Social posts" />;
  if (!res.isPortalClient) {
    return (
      <>
        {head}
        <EmptyNote>
          This is the client-facing portal. You&apos;re signed in as a staff member, so there is no client account to review posts against. Open the post from the
          department&apos;s Social Media pages instead.
        </EmptyNote>
      </>
    );
  }
  if (!res.list) {
    return (
      <>
        {head}
        <EmptyNote>The post approval page is not available on this server yet. Your older post reviews are still where they were.</EmptyNote>
      </>
    );
  }

  // The way in: the post's own state says which tab holds it. Redirect there (once: the next request already agrees) so the URL is the post's real place.
  if (target && tabForState(target.state) !== tab) redirect(socialHref({ month, clientId }, { tab: tabForState(target.state), post: target.id }));

  let items = res.list.items;
  // The link may name a post that the first page of a long list does not reach (another month, another page): it is shown first, never dropped.
  if (target && !items.some((p) => p.id === target.id)) items = [target, ...items];
  const openStoryId = target?.format === "story" && (stories ?? []).some((s) => s.id === target.id) ? target.id : null;
  const { counts } = res.list;
  const todayMonth = todayIsoInDisplayZone().slice(0, 7);

  return (
    <>
      <PortalPageHead
        eyebrow="Your input"
        title="Social posts"
        lead={
          counts.toReview > 0
            ? `${counts.toReview} ${counts.toReview === 1 ? "post is" : "posts are"} waiting for your approval before ${counts.toReview === 1 ? "it goes" : "they go"} out.`
            : "Nothing is waiting for your approval right now. Approved posts and past decisions stay here."
        }
      />
      <PortalSocialCountsBar counts={counts} q={q} />
      <PortalSocialFilters q={q} todayMonth={todayMonth} clients={clients} />
      {olderPending > 0 && (
        <p className="ps-older">
          <Link className="ps-link" href="/portal/social-reviews">Older post reviews</Link>
          {` (${olderPending} still ${olderPending === 1 ? "waits" : "wait"} for you)`}
        </p>
      )}
      <PortalSocialView
        tab={tab} items={items} stories={stories ?? []} tenant={tenant} tabs={<PortalSocialTabs q={q} />}
        focusPostId={target?.id ?? null} openStoryId={openStoryId} missingPost={post !== null && target === null}
        nextHref={res.list.nextCursor ? socialHref(q, { cursor: res.list.nextCursor }) : null}
      />
    </>
  );
}
