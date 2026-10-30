import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartmentNode } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getClientBrandBook } from "@/lib/socialClient-data";
import { readAssetChoices } from "@/lib/socialPipeline-data";
import { getSavedCollections, getSavedItems } from "@/lib/socialSaved-data";
import { clientsMineFirst, openCollection, parseSavedView, storableCollections, SAVED_NEVER_PORTAL } from "@/lib/socialSaved";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SavedAddForm } from "@/components/social/SavedAddForm";
import { SavedClientPicker, SavedCollectionTiles, SavedEntriesView, SavedFilters } from "@/components/social/SavedBank";
import "@/components/social/cycles.css";
import "@/components/social/reports.css";
import "@/components/social/saved.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ client?: string | string[]; collection?: string | string[]; pillar?: string | string[]; used?: string | string[]; source?: string | string[]; cursor?: string | string[] }>;

// SCP-5e (BFF §63.26, §63.17): Saved, each client's content bank, seen by the team only. A client picker (the caller's clients first, as Profile), the company's collections in its order as mosaics with
// counts and previews, and one collection's entries, paged, with the pillar, used and source filters as links. The photos are the designs' photos, the kept assets and the kept links; the posts are the
// approved ones; the hashtag sets are the brand book's; captions, templates and references are the bank's own. The team adds (a link, a text or an Asset Library photo; a video is a Drive link, SCP-Q30);
// an item's author, the client's officer and the four change or delete it. The server decides each write, and its refusal is said in words beside the control. A refused read is "no access" and a failed
// one is "cannot tell", never an empty bank. The page belongs to the Social Media workspace only, and is never in the portal.
export default async function SavedPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartmentNode(userId, tenant, deptId);
  if (!dept) notFound();
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const view = parseSavedView(await searchParams);
  const [all, mine] = await Promise.all([getAllocation(userId, tenant), getAllocation(userId, tenant, { mine: true })]);
  if (all.kind === "forbidden") return <ReadRefusal subject="The content bank" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (all.kind === "unavailable") return <ReadRefusal subject="The content bank" kind="unavailable" reason={all.reason} />;

  const clients = clientsMineFirst(all.data.filter((r) => r.status !== "closed"), mine.kind === "ok" ? mine.data : []);
  if (clients.length === 0) {
    return (
      <Card title="Saved">
        <p className="scp-note" role="status">There is no client yet, so there is no content bank to show. A Social Media head adds clients on the Allocation page.</p>
      </Card>
    );
  }
  const asked = view.client ? clients.find((c) => c.engagementId === view.client) : undefined;
  const current = asked ?? clients[0];

  const read = await getSavedCollections(userId, tenant, current.engagementId);
  const picker = <SavedClientPicker deptId={deptId} clients={clients} current={current.engagementId} />;
  const head = (
    <>
      <p className="scp-lede">
        Each client&apos;s content bank: photos with where they come from and whether a post uses them, approved posts, hashtag sets, and the captions, templates and references the team keeps. {SAVED_NEVER_PORTAL}
      </p>
      {mine.kind === "unavailable" && <p className="scp-note" role="status">Your own clients could not be read, so the list is in the company&apos;s order. {mine.reason}</p>}
      {view.client && !asked && <p className="scp-note" role="status">That client is not on the list, so the first one is shown.</p>}
      {picker}
    </>
  );
  if (read.kind !== "ok") {
    return (
      <Card title="Saved">
        {head}
        {read.kind === "forbidden"
          ? <ReadRefusal subject="This client's content bank" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." inline />
          : <ReadRefusal subject="This client's content bank" kind="unavailable" reason={read.reason} inline />}
      </Card>
    );
  }
  const { collections, canAdd } = read.data;
  const open = openCollection(collections, view.collection);
  const [entries, brand, assets] = await Promise.all([
    open ? getSavedItems(userId, tenant, current.engagementId, { collection: open.key, pillar: view.pillar, used: view.used, source: view.source, cursor: view.cursor }) : Promise.resolve(null),
    getClientBrandBook(userId, tenant, current.clientId),
    canAdd && storableCollections(collections).some((c) => c.holds.includes("asset")) ? readAssetChoices(userId, tenant) : Promise.resolve(null),
  ]);
  const pillars = brand.kind === "ok" ? brand.data?.contentPillars ?? [] : [];

  return (
    <Card title="Saved">
      {head}
      <div className="scp-saved">
        <div className="scp-saved__head">
          <h2 className="scp-saved__name">{current.clientName}</h2>
        </div>
        {brand.kind !== "ok" && <p className="scp-note" role="status">The brand book could not be read just now, so the pillar lists are empty.</p>}
        <SavedAddForm
          key={current.engagementId} engagementId={current.engagementId} collections={collections} canAdd={canAdd} pillars={pillars}
          assets={assets && assets.kind === "ok" ? assets.data : null} initialCategory={open?.key ?? null}
        />
        {collections.length === 0 ? (
          <p className="scp-note" role="status">This company has no collections switched on. A Social Media head sets them in Settings.</p>
        ) : (
          <SavedCollectionTiles deptId={deptId} client={current.engagementId} collections={collections} open={open?.key ?? null} />
        )}
        {view.collection && !open && <p className="scp-note" role="status">That collection is not one of this company&apos;s, so none is open.</p>}
        {open && entries && entries.kind === "ok" && (
          <>
            <SavedFilters deptId={deptId} client={current.engagementId} collection={open} view={view} pillars={pillars} />
            <SavedEntriesView
              deptId={deptId} client={current.engagementId} collection={open} entries={entries.data.entries} nextCursor={entries.data.nextCursor} view={view}
              viewerId={userId} pillars={pillars} collections={collections}
            />
          </>
        )}
        {open && entries && entries.kind === "forbidden" && <ReadRefusal subject={`The ${open.label} collection`} kind="forbidden" inline />}
        {open && entries && entries.kind === "unavailable" && <ReadRefusal subject={`The ${open.label} collection`} kind="unavailable" reason={entries.reason} inline />}
        {!open && collections.length > 0 && <p className="scp-note">Open a collection to see what is in it.</p>}
      </div>
    </Card>
  );
}
