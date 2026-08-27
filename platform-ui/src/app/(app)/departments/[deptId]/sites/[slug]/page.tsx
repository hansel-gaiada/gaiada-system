import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Card, StatusBadge } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ContractCard } from "@/components/webdesk/ContractCard";
import { ReleaseActionsPanel } from "@/components/webdesk/ReleaseActionsPanel";
import { SubmissionsPanel } from "@/components/webdesk/SubmissionsPanel";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  fetchSiteRegistry, fetchReleaseHistory, fetchSubmissions, fetchContractPinStatuses, safeConsoleRead,
} from "@/lib/webdesk";
import { listAutomationApprovals } from "@/lib/automationApprovals";

type Params = Promise<{ deptId: string; slug: string }>;
type SearchParams = Promise<{ formId?: string }>;

// WSK-24 — the Sites tab, per-site detail: contract card (pin vs latest + locale coverage),
// releases + WS4-gated actions (disabled-with-reason — the write channel isn't built, see
// ReleaseActionsPanel's own header), and submissions (PII-aware). Design §08; BFF §24.
export default async function SiteDetailPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, slug } = await params;
  const { formId } = await searchParams;
  if (!tenant) notFound();

  // The registry read gives us this site's own row (status/framework/staging URL) for the header —
  // §24 has no single-site GET, only the list, so this is the same read the registry tab makes.
  const registryRead = await safeConsoleRead(() => fetchSiteRegistry(userId, tenant));
  if (!registryRead.ok) {
    return registryRead.reason === "not_enabled"
      ? <Card title="Sites"><EmptyNote>WebDesk isn&apos;t turned on for this company yet.</EmptyNote></Card>
      : <ReadRefusal subject="this site" kind="forbidden" />;
  }
  const site = registryRead.data.sites.find((s) => s.slug === slug);
  if (!site) notFound();

  const [releasesRead, submissionsRead, pinsRead, approvalsResult] = await Promise.all([
    safeConsoleRead(() => fetchReleaseHistory(userId, tenant, slug)),
    safeConsoleRead(() => fetchSubmissions(userId, tenant, slug, formId)),
    safeConsoleRead(() => fetchContractPinStatuses(userId, tenant, slug)),
    // Best-effort/informational only (ReleaseActionsPanel's own header) — a refused or unavailable
    // read here degrades to "couldn't be read", never treated as "no decisions exist".
    listAutomationApprovals(userId, tenant, { origin: "webdev" }).then(
      (rows) => ({ ok: true as const, rows }),
      () => ({ ok: false as const, rows: [] }),
    ),
  ]);

  const pin = pinsRead.ok ? (pinsRead.data[0] ?? null) : null;

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <PageHeader
        eyebrow="Site"
        title={site.slug}
        subtitle={site.stagingUrl ? site.stagingUrl : "No staging URL on file"}
        breadcrumbs={[
          { label: "Departments", href: "/departments" },
          { label: "Sites", href: `/departments/${deptId}/sites` },
          { label: site.slug },
        ]}
        actions={<StatusBadge label={site.status} />}
      />

      {site.repoUrl && (
        <p style={{ font: "400 13px var(--font-body)" }}>
          Repository: <Link href={site.repoUrl}>{site.repoUrl}</Link>
        </p>
      )}

      <ContractCard pin={pin} pinsAvailable={pinsRead.ok} />

      <ReleaseActionsPanel
        slug={slug}
        releases={releasesRead.ok ? releasesRead.data.releases : []}
        meta={releasesRead.ok ? releasesRead.data.meta : { stale: true, source: "unavailable", asOf: null, reason: releasesRead.reason }}
        approvals={approvalsResult.ok ? approvalsResult.rows : null}
      />

      <SubmissionsPanel
        submissions={submissionsRead.ok ? submissionsRead.data.submissions : []}
        meta={submissionsRead.ok ? submissionsRead.data.meta : { stale: true, source: "unavailable", asOf: null, reason: submissionsRead.reason }}
        formId={formId}
      />
    </div>
  );
}
