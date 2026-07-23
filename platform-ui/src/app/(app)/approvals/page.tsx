import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import {
  listApprovals, originCounts, isApprovalOrigin, ORIGIN_LABEL,
  type ApprovalOrigin, type ApprovalSort,
} from "@/lib/approvals";
import { decideApprovalItem } from "../actions";
import { Card, Eyebrow } from "@/components/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ScopePill } from "@/components/scope/ScopePill";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
import { OriginFilterBar } from "@/components/approvals/OriginFilterBar";
import { ApprovalsList } from "@/components/approvals/ApprovalsList";
import "@/components/approvals/approvals.css";

type SearchParams = Promise<{ scope?: string; origin?: string; sort?: string }>;

function parseSort(raw: string | undefined): ApprovalSort {
  return raw === "age" ? "age" : "urgency";
}

// How many "Recently decided" rows to surface per UX-2 §2.2 — a glance-back
// list, not a full audit trail (a dedicated history view is future scope).
const RECENTLY_DECIDED_LIMIT = 8;

interface Current { scope: string; origin?: ApprovalOrigin; sort: ApprovalSort }

function hrefFor(current: Current, overrides: Partial<Current>): string {
  const merged = { ...current, ...overrides };
  const p = new URLSearchParams();
  if (merged.scope !== "all") p.set("scope", merged.scope);
  if (merged.origin) p.set("origin", merged.origin);
  if (merged.sort !== "urgency") p.set("sort", merged.sort);
  const qs = p.toString();
  return qs ? `/approvals?${qs}` : "/approvals";
}

// WSUX-6 (UX-2 §2, contract §9a) — the unified triage inbox over
// `GET /api/approvals` (WSUX-1) with inline decide through the WSUX-2 façade.
//
// WSUX-11 design-QA Minor-1 ratification (2026-07-23, owner-approved toward
// the binding §2.2 mockup): pending (actionable) and "Recently decided" are
// now BOTH rendered as distinct, always-visible sections instead of folded
// into a Pending/Decided either-or toggle — the mockup's "glance at both at
// once" capability. This costs a second server-side fetch (status=pending +
// status=decided), which the contract already supports per-status. The
// origin facet bar and scope pill still govern both sections at once; the
// Urgency/Oldest sort toggle now applies to the Pending section only (the
// Decided section is inherently ordered by recency, which needs no toggle).
export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const { scope: rawScope, origin: rawOrigin, sort: rawSort } = await searchParams;

  const companies = accessibleCompanies(me);
  const scope = rawScope && companies.some((c) => c.id === rawScope) ? rawScope : "all";
  const origin = isApprovalOrigin(rawOrigin) ? rawOrigin : undefined;
  const sort = parseSort(rawSort);
  const current: Current = { scope, origin, sort };

  const [pending, decided] = await Promise.all([
    listApprovals(userId, { scope, status: "pending", sort }),
    listApprovals(userId, { scope, status: "decided", sort: "age" }),
  ]);

  const counts = originCounts(pending.envelope.items);
  const total = pending.envelope.items.length;
  const pendingShown = origin ? pending.envelope.items.filter((i) => i.origin === origin) : pending.envelope.items;
  const decidedShown = (origin ? decided.envelope.items.filter((i) => i.origin === origin) : decided.envelope.items)
    .slice(0, RECENTLY_DECIDED_LIMIT);

  const pendingEmptyText =
    total === 0
      ? "Nothing awaiting your review."
      : `No ${origin ? ORIGIN_LABEL[origin] : ""} items pending.`;
  const decidedEmptyText =
    decided.envelope.items.length === 0
      ? "No decisions recorded yet."
      : `No ${origin ? ORIGIN_LABEL[origin] : ""} decisions recently.`;
  const showAllOriginsLink = origin !== undefined && pendingShown.length === 0;

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

      {scope === "all" && !pending.unavailable && <EnvelopeBanner companies={pending.envelope.companies} />}
      {pending.unavailable && (
        <p className="sys-empty-note" role="status">
          Approvals aren&apos;t reachable right now — showing nothing rather than a guess. Try again shortly.
        </p>
      )}

      <div className="approvals-toolbar">
        <OriginFilterBar counts={counts} total={total} active={origin} buildHref={(next) => hrefFor(current, { origin: next })} />
        <div className="approvals-sort-toggle" role="group" aria-label="Sort pending by">
          <a
            href={hrefFor(current, { sort: "urgency" })}
            className={sort === "urgency" ? "is-active" : ""}
            aria-current={sort === "urgency" ? "true" : undefined}
          >
            Urgency
          </a>
          <a
            href={hrefFor(current, { sort: "age" })}
            className={sort === "age" ? "is-active" : ""}
            aria-current={sort === "age" ? "true" : undefined}
          >
            Oldest
          </a>
        </div>
      </div>

      <Card title="Pending">
        <ApprovalsList items={pendingShown} mode="pending" decide={decideApprovalItem} emptyText={pendingEmptyText} />
        {showAllOriginsLink && (
          <p className="sys-empty-note" style={{ marginTop: -8 }}>
            <a href={hrefFor(current, { origin: undefined })}>Show all origins</a>
          </p>
        )}
      </Card>

      <Card title="Recently decided" style={{ marginTop: 20 }}>
        {decided.unavailable ? (
          <p className="sys-empty-note" role="status">
            Recently-decided history isn&apos;t reachable right now — showing nothing rather than a guess.
          </p>
        ) : (
          <ApprovalsList items={decidedShown} mode="decided" decide={decideApprovalItem} emptyText={decidedEmptyText} />
        )}
      </Card>
    </>
  );
}
