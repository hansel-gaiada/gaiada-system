import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card, HairlineTable } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { CostTierBadge } from "@/components/search/CostTierBadge";
import { KeywordWorkbench } from "@/components/search/KeywordWorkbench";
import { NewKeywordSetForm } from "@/components/search/NewKeywordSetForm";
import {
  listEngagements, listKeywordSets, listKeywords, getEngagementScope, isToggleEnabled,
  type SearchEngagement, type SearchKeywordSet,
} from "@/lib/searchMarketing";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
// Next 15: searchParams is async.
type SearchParams = Promise<{ engagementId?: string; setId?: string }>;

// Keywords (SM-09's import/embed/cluster endpoints, wired up here per SM-12). Keyword sets hang off
// an engagement (`keyword-sets?engagementId=`), so the tab's first choice is which engagement to
// work in — same pattern the Site Audit tab uses for property selection. Clustering itself runs on
// our own crawlers'/AI's data and is FREE; per-keyword search VOLUME rides the metered `volume`
// scope toggle (D-11), so that state is read from the engagement's own scope (never assumed) and
// passed straight into <KeywordWorkbench> — see keywordVolumeState's header note in
// searchMarketingShared.ts for why "off" and "not pulled yet" must render as two different things.
export default async function DepartmentSeoKeywordsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const sp = await searchParams;
  const canManage = can(me, "search.manage", tenant);

  const engagements = await listEngagements(userId, tenant);
  const engagementId = sp.engagementId && engagements.some((e) => e.id === sp.engagementId) ? sp.engagementId : engagements[0]?.id;

  const [keywordSets, scope] = engagementId
    ? await Promise.all([listKeywordSets(userId, tenant, engagementId), getEngagementScope(userId, tenant, engagementId)])
    : [[] as SearchKeywordSet[], null];

  const setId = sp.setId && keywordSets.some((s) => s.id === sp.setId) ? sp.setId : keywordSets[0]?.id;
  const keywords = setId ? await listKeywords(userId, tenant, setId) : [];
  const volumeScopeEnabled = scope ? isToggleEnabled(scope.toolScope, "volume") : false;

  return (
    <>
      <Card title="Keywords" headerRight={<CostTierBadge tier="free" />}>
        {engagements.length === 0 ? (
          <TeachState
            glyph="⌗"
            title="No engagements yet"
            body="Keyword sets belong to a client engagement — set one up from the Engagements tab first."
            ctaLabel="Go to Engagements"
            ctaHref={`/departments/${deptId}/engagements`}
          />
        ) : (
          <>
            <form className="lux-filters" method="get" aria-label="Engagement filter" style={{ marginBottom: 16 }}>
              <label className="lux-filters__field">
                <span>Engagement</span>
                <select name="engagementId" defaultValue={engagementId}>
                  {engagements.map((e: SearchEngagement) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </label>
              <div className="lux-filters__actions">
                <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">View</button>
              </div>
            </form>

            {keywordSets.length === 0 ? (
              <TeachState
                glyph="＋"
                title="No keyword sets yet"
                body="A keyword set is what import/embed/cluster all key off. Create the first one for this engagement below."
              />
            ) : (
              <HairlineTable
                columns={[{ label: "Set" }, { label: "Source" }, { label: "" }]}
                rows={keywordSets.map((s) => [
                  s.name,
                  s.source,
                  <Link
                    key="l"
                    href={`/departments/${deptId}/keywords?engagementId=${engagementId}&setId=${s.id}`}
                    style={{ font: "600 12px var(--font-body)", color: s.id === setId ? "var(--erp-accent)" : "var(--text-primary)" }}
                  >
                    {s.id === setId ? "Viewing" : "Open"}
                  </Link>,
                ])}
                tcols="2fr 1fr .8fr"
              />
            )}

            {canManage && engagementId && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: keywordSets.length > 0 ? "0.5px solid var(--erp-hairline)" : undefined }}>
                <NewKeywordSetForm tenantId={tenant} engagementId={engagementId} deptId={deptId} />
              </div>
            )}
          </>
        )}
      </Card>

      {setId && (
        <Card title={`Set — ${keywordSets.find((s) => s.id === setId)?.name ?? setId}`}>
          <KeywordWorkbench
            tenantId={tenant}
            setId={setId}
            keywords={keywords}
            volumeScopeEnabled={volumeScopeEnabled}
            canManage={canManage}
          />
        </Card>
      )}
    </>
  );
}
