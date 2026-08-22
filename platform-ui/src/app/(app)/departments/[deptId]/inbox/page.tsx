import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card } from "@/components/ui";
import { BackendPending } from "@/components/BackendPending";
import { AccessDenied } from "@/components/social/AccessDenied";
import { InboxWorkspace, type InboxAccountInfo } from "@/components/social/InboxWorkspace";
import {
  getPublisherStatus, listInboxThreads, listThreadMessages, listAccounts,
} from "@/lib/social";
import { describeRefusal, type InboxThread, type InboxMessage } from "@/lib/socialShared";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ thread?: string }>;

// Inbox (SMM-11 route; SMM-15/16/17 backend; THIS ticket, SMM-18, is the first UI). Replaces the
// BackendPending shell SMM-15/16 left behind — those tickets landed, so the honest state today is
// no longer "the backend doesn't exist" but "the backend exists and reports zero connected
// accounts, on every network, and separately has no queue-LIST endpoint yet" — two different facts,
// both named explicitly below rather than folded into one generic empty state.
export default async function DepartmentSocialInboxPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  if (!can(me, "social.inbox.read", tenant)) {
    return (
      <Card title="Inbox">
        <AccessDenied what="view the engagement inbox" />
      </Card>
    );
  }

  const status = await getPublisherStatus(userId, tenant);
  if (status.forbidden) {
    return (
      <Card title="Inbox">
        <AccessDenied what="read the publisher connection status" />
      </Card>
    );
  }

  // ── the honest empty state (D-23 + Postiz's own no-inbound-surface fact) ──────────────────────
  // `inboxSurface` reads "none" for every real deployment today: no platform app credential is
  // registered on any network (D-23, `platform_app_not_registered` — app reviews deferred to
  // staging), and even setting that aside, the DEFAULT driver (Postiz) has ZERO inbound engagement
  // surface for any network at all (`publisher/postiz.ts`'s own header) — a structural fact, not a
  // temporary one. Never a spinner, never a bare "no messages": say both reasons plainly.
  if (status.data.inboxSurface !== "available") {
    return (
      <Card title="Inbox">
        <InboxUnavailableNotice driver={status.data.driver} />
      </Card>
    );
  }

  // ── the queue-list gap (SMM-18's own finding — see socialShared.ts's `InboxThread` header) ─────
  // `listInboxThreads` calls a PROPOSED endpoint the real backend does not have yet. Caught here,
  // never left to bubble into an unhandled 500 or, worse, silently rendered as "zero threads" —
  // either of which would be the exact frontend-first-drift bug class this program names by name.
  let threads: InboxThread[] = [];
  let queueGapMessage: string | null = null;
  try {
    threads = await listInboxThreads(userId, tenant, { status: "all" });
  } catch (e) {
    queueGapMessage = e instanceof Error ? e.message : "the backend refused this call";
  }
  if (queueGapMessage !== null) {
    return (
      <Card title="Inbox">
        <BackendPending
          what={`The triage-queue list endpoint isn't available on this backend yet (SMM-18's own gap — social.controller.ts has message-level reply endpoints only, no GET threads / GET threads/:id). The attempted call answered: "${queueGapMessage}".`}
          contract="modules/social — SMM-18 follow-up: GET threads / GET threads/:id / thread assign+escalate writes"
        />
      </Card>
    );
  }

  const sp = await searchParams;
  const selectedThreadId = sp.thread ?? null;
  let messages: InboxMessage[] = [];
  let messagesForbidden = false;
  if (selectedThreadId) {
    const r = await listThreadMessages(userId, tenant, selectedThreadId);
    messages = r.data;
    messagesForbidden = r.forbidden;
  }

  // Accounts (SMM-05 registry) — resolved once for the whole queue so each row can show the
  // network/handle the thread's `accountId` targets, mirroring the calendar's own bounded-fetch
  // discipline rather than an N+1 read per thread.
  const accountsResult = await listAccounts(userId, tenant);
  const accountsById: Record<string, InboxAccountInfo> = {};
  for (const a of accountsResult.data) {
    accountsById[a.id] = { handle: a.handle, displayName: a.displayName, network: a.network };
  }

  return (
    <Card title="Inbox">
      <InboxWorkspace
        tenantId={tenant}
        deptId={deptId}
        threads={threads}
        accountsById={accountsById}
        selectedThreadId={selectedThreadId}
        messages={messages}
        messagesForbidden={messagesForbidden}
        canReply={can(me, "social.inbox.reply", tenant)}
        canAssign={can(me, "social.inbox.assign", tenant)}
        canEscalate={can(me, "social.inbox.escalate", tenant)}
      />
    </Card>
  );
}

/** The honest "why is this empty" panel — server-rendered, no interactivity needed. Deliberately
 *  NOT `TeachState` (that component's warm "here's what to do" tone fits a first-run setup step;
 *  this is a deployment-level fact nobody using this console can act on directly) and NOT
 *  `BackendPending` (the backend for THIS surface is not missing — it answered; the honest fact is
 *  that no account can be connected anywhere yet, D-23). */
function InboxUnavailableNotice({ driver }: { driver: string | null }) {
  return (
    <div
      role="note"
      style={{
        display: "flex", flexDirection: "column", gap: 8,
        border: "0.5px solid var(--erp-hairline)", borderLeft: "3px solid var(--erp-accent)",
        background: "var(--tint-hover)", padding: "14px 16px",
      }}
    >
      <span style={{ font: "700 11px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-accent)" }}>
        No inbox to show yet
      </span>
      <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
        {describeRefusal("platform_app_not_registered")}
      </p>
      <p style={{ margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
        Separately, this deployment&rsquo;s configured driver
        {driver ? <> (<code style={{ font: "600 12px var(--font-mono, monospace)" }}>{driver}</code>)</> : ""} has
        no inbound engagement surface at all for its default network mode — Postiz, the platform&rsquo;s
        default publisher engine, exposes zero comment/DM/mention reading capability on any network. Until
        an app is registered and a driver that actually supports reading comments (today: only the
        LinkedIn/YouTube paths of the <code style={{ font: "600 12px var(--font-mono, monospace)" }}>direct</code> driver)
        is connected to a real account, an empty inbox here is the correct, honest answer — not a bug,
        not a loading state stuck forever.
      </p>
    </div>
  );
}
