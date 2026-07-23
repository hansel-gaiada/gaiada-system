import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import {
  listApprovals, originCounts, isApprovalOrigin, ORIGIN_LABEL,
  type ApprovalOrigin, type ApprovalStatus, type ApprovalSort,
} from "@/lib/approvals";
import { decideApprovalItem } from "../actions";
import { Card, Eyebrow } from "@/components/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ScopePill } from "@/components/scope/ScopePill";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
import { OriginFilterBar } from "@/components/approvals/OriginFilterBar";
import { ApprovalsList } from "@/components/approvals/ApprovalsList";
import "@/components/approvals/approvals.css";

type SearchParams = Promise<{ scope?: string; origin?: string; status?: string; sort?: string }>;

function parseStatus(raw: string | undefined): ApprovalStatus {
  return raw === "decided" ? "decided" : "pending";
}
function parseSort(raw: string | undefined): ApprovalSort {
  return raw === "age" ? "age" : "urgency";
}

interface Current { scope: string; origin?: ApprovalOrigin; status: ApprovalStatus; sort: ApprovalSort }

function hrefFor(current: Current, overrides: Partial<Current>): string {
  const merged = { ...current, ...overrides };
  const p = new URLSearchParams();
  if (merged.scope !== "all") p.set("scope", merged.scope);
  if (merged.origin) p.set("origin", merged.origin);
  if (merged.status !== "pending") p.set("status", merged.status);
  if (merged.sort !== "urgency") p.set("sort", merged.sort);
  const qs = p.toString();
  return qs ? `/approvals?${qs}` : "/approvals";
}

// WSUX-6 (UX-2 §2, contract §9a) — the unified triage inbox over
// `GET /api/approvals` (WSUX-1) with inline decide through the WSUX-2 façade.
// One list, one origin/scope/status/sort axis set — replaces the old
// agency-only per-company Card loop.
export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const { scope: rawScope, origin: rawOrigin, status: rawStatus, sort: rawSort } = await searchParams;

  const companies = accessibleCompanies(me);
  const scope = rawScope && companies.some((c) => c.id === rawScope) ? rawScope : "all";
  const origin = isApprovalOrigin(rawOrigin) ? rawOrigin : undefined;
  const status = parseStatus(rawStatus);
  const sort = parseSort(rawSort);
  const current: Current = { scope, origin, status, sort };

  const { envelope, unavailable } = await listApprovals(userId, { scope, status, sort });
  const counts = originCounts(envelope.items);
  const total = envelope.items.length;
  const shown = origin ? envelope.items.filter((i) => i.origin === origin) : envelope.items;

  const emptyText =
    total === 0
      ? status === "pending" ? "Nothing awaiting your review." : "No decisions recorded yet."
      : `No ${origin ? ORIGIN_LABEL[origin] : ""} items ${status === "pending" ? "pending" : "decided"}.`;
  const showAllOriginsLink = origin !== undefined && shown.length === 0;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 22 }}>
        <div>
          <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Approvals" }]} />
          <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Workspace</Eyebrow>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Approvals</h1>
          <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 560 }}>
            Everything awaiting your decision, unified across agency, pipeline, HR, automation, and agent requests.
          </p>
        </div>
        <ScopePill companies={companies} value={scope} onChangeHref={(v) => hrefFor(current, { scope: v })} />
      </div>

      {scope === "all" && !unavailable && <EnvelopeBanner companies={envelope.companies} />}
      {unavailable && (
        <p className="sys-empty-note" role="status">
          Approvals aren&apos;t reachable right now — showing nothing rather than a guess. Try again shortly.
        </p>
      )}

      <div className="approvals-toolbar">
        <OriginFilterBar counts={counts} total={total} active={origin} buildHref={(next) => hrefFor(current, { origin: next })} />
        <div style={{ display: "flex", gap: 18 }}>
          <div className="approvals-status-toggle" role="group" aria-label="Status">
            <a href={hrefFor(current, { status: "pending" })} className={status === "pending" ? "is-active" : ""}>Pending</a>
            <a href={hrefFor(current, { status: "decided" })} className={status === "decided" ? "is-active" : ""}>Decided</a>
          </div>
          <div className="approvals-sort-toggle" role="group" aria-label="Sort">
            <a href={hrefFor(current, { sort: "urgency" })} className={sort === "urgency" ? "is-active" : ""}>Urgency</a>
            <a href={hrefFor(current, { sort: "age" })} className={sort === "age" ? "is-active" : ""}>Oldest</a>
          </div>
        </div>
      </div>

      <Card>
        <ApprovalsList items={shown} mode={status} decide={decideApprovalItem} emptyText={emptyText} />
        {showAllOriginsLink && (
          <p className="sys-empty-note" style={{ marginTop: -8 }}>
            <a href={hrefFor(current, { origin: undefined })}>Show all origins</a>
          </p>
        )}
      </Card>
    </>
  );
}
