import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { AskLinks } from "@/components/requests/AskLinks";
import { RequestForm } from "@/components/requests/RequestForm";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { activeCompany } from "@/lib/companyContext";
import { can } from "@/lib/rbac";
import { departmentForWorkspace } from "@/lib/workspaceAccess";
import { readOrgRoot, readSharedCampaigns } from "@/lib/campaigns-data";
import { readRequestRoutes } from "@/lib/requests-data";
import {
  REQUEST_TARGETS, findRoute, parseTarget, partOptions, requestKindLabel, routeAskLabel, routeHref, routeToText,
} from "@/lib/requests";
import "@/components/requests/requests.css";

// DW-5c — New request (plan §7.2, contract §32.4). `?to=creatives` asks Creatives for assets, `?to=web-dev` asks Web Dev
// (the registry's ASK_ACTIONS link here). The target is resolved to the ACTIVE company's department whose workspace is
// that key, with the same name match the shell uses (`departmentForWorkspace` over `workspaceFor`), never a second one.
// A company with no such department gets a plain sentence and no form. The org chart is READ first: a tree that cannot be
// read is "unavailable", never "no Creatives department". The kind follows the target. The campaigns offered are those
// where the RECEIVING department has a part (`GET campaigns?unitId=<receiving dept>`), sent as `campaignPartId`.
//
// DW-10e (BFF §60.9): `?route=<routeId>` asks another group company's department through one of the company's routes. The routes
// come from `GET requests/routes` (the asking company's own), NEVER from the active company's tree, and the page does not depend on
// the company being agency-pack: a company with routes is offered them whatever its pack. The form is the same per kind, with no
// campaign picker. Without a target the chooser lists the same-company departments (where the company has them) and then the routes.
export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ to?: string | string[]; route?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const crumbs = [{ label: "Requests", href: "/requests" }, { label: "New request" }];
  const header = <PageHeader title="New request" breadcrumbs={crumbs} />;
  const sp = await searchParams;
  const company = activeCompany(me, tenant);

  // ── A request to another group company, through a route ───────────────────────────────────────
  const routeParam = Array.isArray(sp.route) ? sp.route[0] : sp.route;
  if (routeParam) {
    const routes = await readRequestRoutes(userId, tenant);
    if (routes.kind === "forbidden") return <>{header}<ReadRefusal subject="your company's routes to other companies" kind="forbidden" /></>;
    if (routes.kind === "unavailable") {
      return <>{header}<ReadRefusal subject="Your company's routes to other companies" kind="unavailable" reason={routes.reason} /></>;
    }
    const route = findRoute(routes.data.routes, routeParam);
    if (!route) {
      return (
        <>
          {header}
          <Card title="That route is not available">
            <p className="req-empty">Your company can no longer send requests there.</p>
            <p className="req-note" style={{ marginTop: 8 }}><Link href="/requests/new">Choose where to send a request</Link></p>
          </Card>
        </>
      );
    }
    return (
      <>
        {header}
        <Card title={routeAskLabel(route)}>
          <RequestForm
            kind={route.kind} toUnitId="" toUnitName={route.unit.name} campaigns={null}
            route={{ routeId: route.routeId, companyName: route.company.name, unitName: route.unit.name, requestingCompanyName: company?.name ?? "your company" }}
          />
        </Card>
      </>
    );
  }

  const targetKey = parseTarget(sp.to);
  if (!targetKey) {
    // The chooser: this company's own departments, then its routes to other companies. Each part is read on its own, and a part that
    // cannot be read says so; it is never left out as if there were none.
    const [root, routes] = await Promise.all([readOrgRoot(me, tenant), readRequestRoutes(userId, tenant)]);
    const mayAcross = can(me, "work_request.send_across", tenant);
    const across = routes.kind === "ok" && mayAcross ? routes.data.routes : [];
    const hasOwnTargets = (Object.keys(REQUEST_TARGETS) as (keyof typeof REQUEST_TARGETS)[]).some((k) => departmentForWorkspace(root, company?.vertical, k) !== null);
    const nobody = !hasOwnTargets && across.length === 0 && routes.kind === "ok" && root !== null;
    return (
      <>
        {header}
        <Card title="Who do you want to ask?">
          <p className="req-empty">{nobody ? "There is nobody to send a request to from this company yet." : "Choose a department to ask."}</p>
          <div style={{ marginTop: 12 }}>
            <AskLinks root={root} vertical={company?.vertical} />
          </div>
          {across.length > 0 && (
            <ul className="req-routes" aria-label="Other companies" style={{ marginTop: 12 }}>
              {across.map((r) => (
                <li key={r.routeId}>
                  <Link href={routeHref(r.routeId)} className="lux-btn lux-btn--ghost lux-btn--sm">{routeToText(r)}</Link>
                  <span className="req-quiet"> {requestKindLabel(r.kind)}</span>
                </li>
              ))}
            </ul>
          )}
          {routes.kind === "unavailable" && (
            <p className="req-note" style={{ marginTop: 12 }}>
              Your company&apos;s routes to other companies cannot be read right now, so they are not listed. That is not a statement that there are none.
            </p>
          )}
          {routes.kind === "ok" && !routes.data.enabled && (
            <p className="req-note" style={{ marginTop: 12 }}>Requests to other companies are switched off.</p>
          )}
        </Card>
      </>
    );
  }
  const target = REQUEST_TARGETS[targetKey];

  const root = await readOrgRoot(me, tenant);
  if (!root) {
    return (
      <>
        {header}
        <ReadRefusal
          subject={`The org chart`}
          kind="unavailable"
          reason={`It could not be read, so ${target.label} could not be found.`}
        />
      </>
    );
  }
  const dept = departmentForWorkspace(root, company?.vertical, targetKey);
  if (!dept) {
    return (
      <>
        {header}
        <Card title={`No ${target.label} department`}>
          <p className="req-empty">This company has no {target.label} department yet, so there is nobody to send this request to.</p>
          <p className="req-note" style={{ marginTop: 8 }}><Link href="/requests">Back to your requests</Link></p>
        </Card>
      </>
    );
  }

  // Context for the ask, never a routing rule: failing to read it does not stop the request.
  const campaignsRead = await readSharedCampaigns(userId, tenant, dept.id);
  const campaigns = campaignsRead.kind === "ok" ? partOptions(campaignsRead.data) : null;

  return (
    <>
      {header}
      <Card title={target.kind === "assets" ? `Ask ${target.label} for assets` : `Ask ${target.label}`}>
        <RequestForm kind={target.kind} toUnitId={dept.id} toUnitName={dept.name} campaigns={campaigns} />
      </Card>
    </>
  );
}
