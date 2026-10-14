import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card, StatusBadge } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { DescriptionList } from "@/components/DescriptionList";
import { RequestActions } from "@/components/requests/RequestActions";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canInUnit, can, leadUnits, unitPathOf } from "@/lib/rbac";
import { formatDateTime } from "@/lib/format";
import { readLibraryAssets, readRequestDetail, readTaskAssigneeIds } from "@/lib/requests-data";
import { readFigmaLinks } from "@/lib/figma-data";
import { readFiles } from "@/lib/entities";
import { FilesPanel } from "@/components/FilesPanel";
import { connectionsHrefFor } from "@/lib/figma";
import { Designs } from "@/components/figma/Designs";
import { readOrgRoot } from "@/lib/campaigns-data";
import {
  assetDownloadHref, formLinks, formSummary, neededByText, requestActions, requestKindLabel, requestStatusLabel, routeText,
  workLink, workText,
} from "@/lib/requests";
import "@/components/requests/requests.css";

// DW-5c: one request (contract §32.5, plan §7.3). Reads `GET requests/:id`: the ask, its status, the work item READ
// LIVE (a PM task's status and responsible person, or a change request's status and route; `work: null` is "the work item
// was removed"), the brief and form as plain text, the delivered assets and the decline reason. A 404 is `notFound()`; a
// refusal or a failed read is a <ReadRefusal>. A record page: area `shared`, so it keeps the workspace you came from.
//
// What is OFFERED is cosmetic and the server decides (a 403 renders as a sentence under the control):
//   Cancel          the requester while open (an engineering request only while its change request is still new);
//   Deliver / more  assets only: a manager, the receiving department's head, or one of the task's assignees;
//   Decline         assets only, while open: a manager or the receiving department's head.
// "Manager or head" is `work_request.decide` through `canInUnit` over the receiving department's path in the org tree,
// read only when it can change the answer; when the tree cannot be read, only the company-wide grant is offered.
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const crumbs = (label: string) => [{ label: "Requests", href: "/requests" }, { label }];
  const result = await readRequestDetail(userId, tenant, id);
  if (result.kind === "forbidden") {
    return <><PageHeader title="Request" breadcrumbs={crumbs("Request")} /><ReadRefusal subject="this request" kind="forbidden" /></>;
  }
  if (result.kind === "unavailable") {
    return <><PageHeader title="Request" breadcrumbs={crumbs("Request")} /><ReadRefusal subject="This request" kind="unavailable" reason={result.reason} /></>;
  }
  const req = result.data;
  if (!req) notFound();

  // Who may be offered what.
  const isRequester = req.requestedBy.id === me.userId;
  let canDecide = can(me, "work_request.decide", tenant);
  if (!canDecide && req.kind === "assets" && req.toUnit.id && leadUnits(me).length > 0) {
    const root = await readOrgRoot(me, tenant);
    canDecide = canInUnit(me, "work_request.decide", tenant, root ? unitPathOf(root, req.toUnit.id) : []);
  }
  let isAssignee: boolean | null = false;
  const live = req.work.state === "live" ? req.work.work : null;
  if (req.kind === "assets" && !canDecide && (req.status === "open" || req.status === "delivered") && live?.type === "pm_task") {
    const ids = await readTaskAssigneeIds(userId, tenant, live.id);
    // A task that could not be read leaves "assignee" unknown: it is not assumed, and the server still decides.
    isAssignee = ids.kind !== "ok" ? null : ids.data ? ids.data.includes(me.userId) : false;
  }
  const offered = requestActions(req, { isRequester, canDecide, isAssignee });

  const needLibrary = offered.deliver || offered.deliverMore;
  const library = needLibrary ? await readLibraryAssets(userId, tenant) : null;
  const delivered = new Set(req.assets.map((a) => a.id));
  const libraryChoices = library?.kind === "ok"
    ? library.data.filter((a) => !delivered.has(a.id)).map((a) => ({ id: a.id, name: a.name, contentType: a.content_type }))
    : null;

  // DW-6k (§36.6): the Figma designs linked to this request. A refusal or failed read is said as itself by the section.
  const figma = await readFigmaLinks(userId, tenant, "work_request", req.id);
  const figmaConnectionsHref = connectionsHrefFor(can(me, "company.manage", tenant), req.toUnit.id, figma);

  // DW-8h (§45.4): the request's files, from an honest read. Everyone who can read the request sees them; the server decides who adds.
  const files = await readFiles(userId, tenant, "work_request", req.id);

  // The page.
  const link = workLink(req, req.work);
  const lines = formSummary(req.kind, req.form);
  const links = formLinks(req.form);
  const items: { label: string; value: ReactNode }[] = [
    { label: "Status", value: <StatusBadge label={req.status} /> },
    { label: "Kind", value: requestKindLabel(req.kind) },
    { label: "From and to", value: routeText(req) },
    { label: "Requested by", value: req.requestedBy.name },
    { label: "Needed by", value: neededByText(req.neededBy) },
    {
      label: "Campaign",
      value: req.campaign ? <Link href={`/agency/${encodeURIComponent(req.campaign.id)}`}>{req.campaign.name}</Link> : "None",
    },
    { label: "Sent", value: formatDateTime(req.createdAt) },
    ...(req.closedAt ? [{ label: requestStatusLabel(req.status), value: formatDateTime(req.closedAt) }] : []),
  ];

  return (
    <>
      <PageHeader title={req.title} breadcrumbs={crumbs(req.title)} />
      <DescriptionList items={items} />

      <div className="req-stack" style={{ marginTop: 28 }}>
        <Card title="The work">
          <p className="req-text">{workText(req.work)}</p>
          {req.status === "open" && req.kind === "assets" && live?.type === "pm_task" && live.isDone && (
            <p className="req-note" style={{ marginTop: 8 }}>The task is done, but no assets have been delivered to this request yet.</p>
          )}
          {link && <p className="req-note" style={{ marginTop: 8 }}><Link href={link.href}>{link.label}</Link></p>}
        </Card>

        {req.status === "declined" && (
          <Card title="Declined">
            <p className="req-text">{req.declineReason ?? "No reason was recorded."}</p>
          </Card>
        )}

        <Card title="Brief">
          {req.brief ? <p className="req-text">{req.brief}</p> : <p className="req-empty">No brief was written.</p>}
        </Card>

        {(lines.length > 0 || links.length > 0) && (
          <Card title="Details">
            <ul className="req-lines">
              {lines.map((l) => (
                <li key={l.label}><span className="req-lines__label">{l.label}</span>{l.value}</li>
              ))}
              {links.map((l) => (
                <li key={l.label}>
                  <span className="req-lines__label">{l.label}</span>
                  {l.href ? <a href={l.href} target="_blank" rel="noopener noreferrer">{l.text}</a> : l.text}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Designs" hint="Figma files and frames for this request. An export lands in the Asset Library, ready to deliver.">
          <Designs targetKind="work_request" targetId={req.id} result={figma} now={Date.now()} connectionsHref={figmaConnectionsHref} />
        </Card>

        <Card title="Files" hint="Briefs, specs and other files for this request. The people on the request can add files.">
          <FilesPanel entityType="work_request" entityId={req.id} revalidate={`/requests/${req.id}`} result={files} />
        </Card>

        {req.kind === "assets" && (
          <Card title="Delivered assets">
            {req.assets.length === 0 ? (
              <p className="req-empty">{req.assetCount > 0 ? `${req.assetCount} delivered, but the list could not be shown.` : "Nothing has been delivered yet."}</p>
            ) : (
              <ul className="req-assets">
                {req.assets.map((a) => (
                  <li key={a.id}>
                    <span>{a.name}</span>
                    {a.contentType && <span className="req-quiet">{a.contentType}</span>}
                    <a href={assetDownloadHref(a.id)}>Download</a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {(offered.cancel || offered.deliver || offered.deliverMore || offered.decline) && (
          <Card title="Actions">
            <RequestActions
              requestId={req.id}
              offered={offered}
              library={needLibrary ? libraryChoices : null}
              libraryReason={library?.kind === "unavailable" ? library.reason : library?.kind === "forbidden" ? "you cannot read it" : null}
            />
          </Card>
        )}
      </div>
    </>
  );
}
