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
import { activeCompany } from "@/lib/companyContext";
import { can } from "@/lib/rbac";
import { formatDateTime } from "@/lib/format";
import { readOutboundDetail, readOutboundFiles } from "@/lib/requests-data";
import {
  formLinks, formSummary, neededByText, outboundActions, outboundAssetHref, outboundFileHref, priceText, requestKindLabel,
  receiverText, requestStatusLabel, safeHttpHref, unitText, workText,
} from "@/lib/requests";
import "@/components/requests/requests.css";

// DW-10e (BFF §60.5, §60.9): a request this company sent to ANOTHER group company's department, as the sender sees it. Reads
// `GET requests/outbound/:id` under the ASKING company (the active one): the ask, its status, "To <unit> · <company>", the work's
// progress (status, done, the responsible person: never the receiver's task or change-request ids), the brief and the form as plain
// text, the decline reason, and for an engineering request the PRICE STATE as a sentence. Never an amount: the wire carries none
// (`normalizePrice` reads two words and nothing else), and the page draws none. The delivered assets and the request's files download
// through the two UI proxies (`/api/requests/outbound/...`), with the caller's own session.
//
// A 404 is `notFound()` (absent, or another person's request when the caller may not read the whole company's, DW-D40); a refusal or a
// failed read is a <ReadRefusal>. What is OFFERED is cosmetic: Cancel for the requester or the company's manager or administrator
// while `open` (an engineering request only while its change request is `new` and no price agreement is live); the server decides.
export default async function OutboundRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const crumbs = (label: string) => [{ label: "Requests", href: "/requests" }, { label }];
  const [result, filesRead] = await Promise.all([readOutboundDetail(userId, tenant, id), readOutboundFiles(userId, tenant, id)]);
  if (result.kind === "forbidden") {
    return <><PageHeader title="Request" breadcrumbs={crumbs("Request")} /><ReadRefusal subject="this request" kind="forbidden" /></>;
  }
  if (result.kind === "unavailable") {
    return <><PageHeader title="Request" breadcrumbs={crumbs("Request")} /><ReadRefusal subject="This request" kind="unavailable" reason={result.reason} /></>;
  }
  const req = result.data;
  if (!req) notFound();

  const provider = req.receivingCompany?.name ?? "The receiving company";
  const requester = activeCompany(me, tenant)?.name ?? "Your company";
  const offered = outboundActions(req, {
    isRequester: req.requestedBy.id === me.userId,
    // `read_across` is held by the company's managers and administrators (PERMISSION-CONTRACT §49), the people who may cancel what
    // the company sent. Cosmetic: an owner who is neither reads 403 as a sentence.
    canManage: can(me, "work_request.read_across", tenant),
  });

  const lines = formSummary(req.kind, req.form);
  const links = formLinks(req.form);
  const items: { label: string; value: ReactNode }[] = [
    { label: "Status", value: <StatusBadge label={req.status} /> },
    { label: "Kind", value: requestKindLabel(req.kind) },
    { label: "Sent to", value: receiverText(req) },
    ...(req.fromUnit ? [{ label: "From", value: unitText(req.fromUnit) }] : []),
    { label: "Requested by", value: req.requestedBy.name },
    { label: "Needed by", value: neededByText(req.neededBy) },
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
          {req.status === "open" && req.kind === "assets" && req.work.state === "live" && req.work.work.type === "pm_task" && req.work.work.isDone && (
            <p className="req-note" style={{ marginTop: 8 }}>The work is done, but no assets have been delivered to this request yet.</p>
          )}
        </Card>

        {req.kind === "engineering" && (
          <Card title="Price">
            <p className="req-text">{priceText(req.price, { provider, requester })}</p>
            <p className="req-note" style={{ marginTop: 8 }}>{provider} bills {requester} for this work as a client. The amounts are never shown on this page.</p>
          </Card>
        )}

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
                    <a href={outboundAssetHref(req.id, a.id)}>Download</a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title="Files" hint="Briefs, specs and other files on this request. You can read and download them here.">
          {filesRead.kind === "forbidden" ? (
            <ReadRefusal inline subject="this request's files" kind="forbidden" />
          ) : filesRead.kind === "unavailable" ? (
            <ReadRefusal inline subject="This request's files" kind="unavailable" reason={filesRead.reason} />
          ) : filesRead.data.length === 0 ? (
            <p className="req-empty">No files are attached to this request.</p>
          ) : (
            <ul className="req-assets">
              {filesRead.data.map((f) => {
                const external = f.url ? safeHttpHref(f.url) : null;
                return (
                  <li key={f.id}>
                    <span>{f.filename}</span>
                    {f.contentType && <span className="req-quiet">{f.contentType}</span>}
                    {f.url
                      ? (external ? <a href={external} target="_blank" rel="noopener noreferrer">Open link</a> : <span className="req-quiet">A link that cannot be opened here</span>)
                      : <a href={outboundFileHref(req.id, f.id)}>Download</a>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {offered.cancel && (
          <Card title="Actions">
            <RequestActions
              requestId={req.id}
              outbound
              offered={{ cancel: true, deliver: false, deliverMore: false, decline: false }}
              library={null}
            />
          </Card>
        )}

        <p className="req-note"><Link href="/requests">Back to your requests</Link></p>
      </div>
    </>
  );
}
