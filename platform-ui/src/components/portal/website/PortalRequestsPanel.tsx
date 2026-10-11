"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { portalApproveRequestAction, portalWithdrawRequestAction } from "@/lib/portalWebsiteActions";
import {
  PORTAL_COPY, PUBLISH_SENT_COPY, PUBLISHED_COPY, requesterLabel, requestState, showApprove, showWithdraw, splitRequests, type RequestView,
} from "@/lib/portalWebsiteModel";
import { clientRefusal } from "@/lib/webdeskClientCopy";
import { describeReasonToken } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import { ConfirmAction } from "./ConfirmAction";
import "@/components/webdesk/content/content.css";

// "Publish requests" (WSK-D58): the client's own requests, every editor's.
//
//   • each request shows WHO filed it, WHEN, the pages in it (with their latest draft version) and its state in plain words;
//   • APPROVE appears ONLY on ANOTHER editor's pending request. The server is the authority: a self-approved batch is a 403 and
//     the answer reads "Another person from your company needs to approve this." (`CLIENT_COPY.selfApprovedBatch`);
//   • WITHDRAW appears on the viewer's OWN pending request;
//   • on one's own pending request the panel says why there is no Approve, rather than leaving a request with no way forward.
// "Published" is said only for a request the server reports as executed. After an approve that executes the words are
// `PUBLISHED_COPY`: §16j returns no staging rebuild state to a client, so nothing more is claimed.

type Notice = { id: string | null; tone: "ok" | "warn" | "bad" | "info"; text: string };

export function PortalRequestsPanel({ clientId, requests, loadProblem }: { clientId: string; requests: RequestView[] | null; loadProblem: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (requests === null) {
    return (
      <div className="wc-banner wc-banner--warn" role="note" data-testid="requests-unavailable">
        <span className="wc-banner__body"><strong>Couldn&apos;t load your publish requests.</strong> {loadProblem ?? PORTAL_COPY.unavailable} This is not the same as having none.</span>
      </div>
    );
  }
  const { pending, decided } = splitRequests(requests);

  const approve = async (r: RequestView) => {
    setBusy(r.approvalId); setNotice(null);
    const res = await portalApproveRequestAction(clientId, r.approvalId);
    if (!mounted.current) return;
    setBusy(null);
    if (res.kind !== "ok") {
      const f = clientRefusal(res, "approve", { itemLabels: r.items.map((i) => i.title) });
      setNotice({ id: r.approvalId, tone: f.tone, text: f.text });
      // A request that was already decided (or is gone) is stale on this page: show the current list.
      if (res.kind === "conflict" || res.kind === "not_found") router.refresh();
      return;
    }
    if (res.data.executionStatus === "failed") {
      setNotice({ id: r.approvalId, tone: "bad", text: `Approved, but publishing didn't complete. ${describeReasonToken(res.data.error)} The request is closed: make the change again or ask Gaiada.` });
    } else if (res.data.reconciled === true) {
      setNotice({ id: r.approvalId, tone: "ok", text: PUBLISHED_COPY });
    } else {
      // Executed but not confirmed live (the versions a request named are not in the list, so no item read can confirm them).
      setNotice({ id: r.approvalId, tone: "warn", text: PUBLISH_SENT_COPY });
    }
    router.refresh();
  };

  const withdraw = async (r: RequestView) => {
    if (!r.tenantSlug || !r.siteId) return;
    setBusy(r.approvalId); setNotice(null);
    const res = await portalWithdrawRequestAction(clientId, { tenantSlug: r.tenantSlug, siteId: r.siteId }, r.approvalId);
    if (!mounted.current) return;
    setBusy(null);
    if (res.kind !== "ok") {
      const f = clientRefusal(res, "withdraw");
      setNotice({ id: r.approvalId, tone: f.tone, text: f.text });
      if (res.kind === "conflict" || res.kind === "not_found") router.refresh();
      return;
    }
    setNotice({ id: r.approvalId, tone: "info", text: PORTAL_COPY.withdrawn });
    router.refresh();
  };

  const row = (r: RequestView) => {
    const st = requestState(r);
    const who = requesterLabel(r);
    const label = `${who === "You" ? "your" : `${who}'s`} request for ${r.itemCount} page${r.itemCount === 1 ? "" : "s"}`;
    return (
      <li key={r.approvalId} className="wc-side-card" data-testid={`request-${r.approvalId}`} data-state={r.status} data-mine={r.requestedByMe || undefined}>
        <h4 style={{ margin: 0 }}>
          {r.itemCount} page{r.itemCount === 1 ? "" : "s"}{r.siteName ? ` on ${r.siteName}` : ""}{" "}
          <span className={`wc-chip${st.tone ? ` wc-chip--${st.tone}` : ""}`} data-testid="request-state">{st.label}</span>
        </h4>
        <p className="wc-publish__sub" data-testid="request-who">Filed by {who} · {formatDateTime(r.createdAt)}</p>
        <ul style={{ margin: "6px 0", paddingLeft: 18 }} aria-label={`Pages in ${label}`}>
          {r.items.map((i) => (
            <li key={i.itemId}>
              {i.available ? <>{i.title}{i.headVersion !== null ? <span className="wc-muted"> · latest draft v{i.headVersion}</span> : null}</> : <span className="wc-muted">A page that is no longer available</span>}
            </li>
          ))}
          {r.itemCount > r.items.length && <li className="wc-muted">and {r.itemCount - r.items.length} more</li>}
        </ul>
        {notice?.id === r.approvalId && (
          <div className={`wc-banner wc-banner--${notice.tone}`} role={notice.tone === "bad" ? "alert" : "status"} data-testid="request-notice"><span className="wc-banner__body">{notice.text}</span></div>
        )}
        <div className="wc-publish__actions">
          {showApprove(r) && (
            <ConfirmAction
              label="Approve" ariaLabel={`Approve ${label}`} testId={`approve-${r.approvalId}`} confirmLabel="Approve and publish"
              question={`Approve and publish ${r.itemCount} page${r.itemCount === 1 ? "" : "s"} now? They go live on your site.`}
              busy={busy === r.approvalId} disabled={busy !== null && busy !== r.approvalId}
              onConfirm={() => approve(r)}
            />
          )}
          {showWithdraw(r) && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" data-testid={`withdraw-${r.approvalId}`} aria-label={`Withdraw ${label}`} disabled={busy !== null} onClick={() => void withdraw(r)}>
              {busy === r.approvalId ? "Working…" : "Withdraw"}
            </button>
          )}
          {r.status === "pending" && r.requestedByMe && (
            <span className="wc-muted" data-testid="needs-colleague">Waiting for another person from your company to approve.</span>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="wc-page" data-testid="requests">
      <h3 style={{ margin: 0 }} id="portal-requests-pending">Waiting for approval</h3>
      {pending.length === 0
        ? <p className="wc-muted" data-testid="requests-none">There are no requests waiting for approval.</p>
        : <ul aria-labelledby="portal-requests-pending" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>{pending.map(row)}</ul>}
      {decided.length > 0 && (
        <>
          <h3 style={{ margin: "8px 0 0" }} id="portal-requests-decided">Recently decided</h3>
          <ul aria-labelledby="portal-requests-decided" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>{decided.map(row)}</ul>
        </>
      )}
    </div>
  );
}
