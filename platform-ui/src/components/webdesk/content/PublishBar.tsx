"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getItemHeadAction, pollApprovalAction, pollBuildStatusAction, requestPublishAction, requestRebuildAction,
  unpublishItemAction, withdrawPublishRequestAction, type SiteScope,
} from "@/lib/webdeskContentActions";
import {
  describeReasonToken, hasPendingChanges, isLive, isOutcomeUnknown, phaseOf, publishStateLabel,
  REBUILD_NOT_CONFIGURED_COPY, REBUILD_NOT_CONFIGURED_REASON, unconfirmedCopy,
  type BuildStatus, type ItemRef, type RequestPhase, type WdResult,
} from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import "./content.css";

// PublishBar — §6 / §9 / §10 in one component: request publish -> "Awaiting approval #…" (Withdraw) ->
// rejected/failed (Request again) | published vN -> rebuilding -> live on staging | rebuild unverified,
// plus unpublish and the "unpublished, staging stale" warning with Request rebuild.
//
// HONESTY RULES (each one a state in §10's table, each one a way to lie by omission):
//  • "Published vN" is shown only after the ITEM READ confirms `publishedVersion === N` (§6: "an
//    ambiguous failure reconciles by reading item state"). The approval saying `executed` is not enough.
//  • "Live on staging" is shown only when the build status says `live`. A rebuild that never confirmed
//    is "unverified", never "live". If the (proposed) build-status route is not served, the panel says
//    the status is unavailable — it does not default to anything.
//  • A write whose outcome is unknown (502 webdesk_ambiguous) is neither "done" nor "failed": it says "We couldn't
//    confirm …, reload to see what happened" and hands the editor `onUnconfirmed` so writes stay off until a re-read.
//  • Nothing here renders without the item it describes; a refusal on a poll keeps the last known phase
//    and says it could not refresh, it does not reset to idle.

const APPROVAL_POLL_MS = 3000;
const BUILD_POLL_MS = 4000;

type Phase =
  | RequestPhase
  | { phase: "verifying" }
  | { phase: "published"; approvedBy: string | null }
  | { phase: "published_unconfirmed"; approvedBy: string | null }
  | { phase: "rebuild_approved"; approvedBy: string | null };

interface Flow {
  kind: "publish" | "rebuild";
  approvalId: string;
  /** The version a publish named; null for a rebuild (and for a request found after a reload). */
  version: number | null;
  phase: Phase;
  /** The last poll failed; the phase above is the last KNOWN one, not a reset. */
  refreshFailed?: string;
}

const shortId = (id: string) => `#${id.slice(0, 8)}`;

function failureCopy(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  switch (r.kind) {
    case "forbidden": return "You don't have permission to do that.";
    case "not_enabled": return r.reason === "module_disabled" ? "The Web Dev module is switched off for this company." : "That isn't available on this deployment yet.";
    case "not_found": return "That item no longer exists in WebDesk.";
    case "conflict": return describeReasonToken(r.slug);
    case "invalid": return r.message;
    case "unavailable": return r.code === "contract_drift" ? `Unexpected response from WebDesk (${r.reason}).` : "WebDesk can't be reached right now.";
  }
}

export function PublishBar({
  scope, item, version, dirty, blocked, initialPending, pendingProblem, initialBuild, buildProblem, stagingUrl,
  onItemChanged, onUnavailable, onUnconfirmed,
}: {
  scope: SiteScope;
  item: ItemRef;
  /** The saved head version a publish request would name. */
  version: number;
  dirty: boolean;
  /** Why requests are disabled (stale / read-only) — null when allowed. */
  blocked: string | null;
  initialPending: { approvalId: string }[] | null;
  pendingProblem: string | null;
  initialBuild: BuildStatus | null;
  buildProblem: string | null;
  /** The item's page on the staging site, when its URL is known. */
  stagingUrl: string | null;
  onItemChanged: (item: ItemRef) => void;
  onUnavailable: (reason: string) => void;
  /** A write's outcome is unknown (502 webdesk_ambiguous). `what` is the action with its article ("the unpublish").
   *  The editor shows the notice and blocks writes until a re-read; without it this bar shows the notice itself. */
  onUnconfirmed?: (what: string) => void;
}) {
  const [flow, setFlow] = useState<Flow | null>(() => {
    const first = initialPending?.[0];
    return first ? { kind: "publish", approvalId: first.approvalId, version: null, phase: { phase: "pending", approvalId: first.approvalId } } : null;
  });
  const [busy, setBusy] = useState<null | "request" | "unpublish" | "withdraw" | "rebuild">(null);
  const [message, setMessage] = useState<{ tone: "info" | "bad" | "ok"; text: string } | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [build, setBuild] = useState<BuildStatus | null>(initialBuild);
  const [buildNote, setBuildNote] = useState<string | null>(buildProblem);
  const [watchBuild, setWatchBuild] = useState<boolean>(initialBuild?.build?.state === "rebuilding");
  const [stagingStale, setStagingStale] = useState<boolean>(initialBuild?.stagingStale ?? false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const live = isLive(item);
  const pending = hasPendingChanges(item);
  const deleted = item.deletedAt !== null;
  const requestBlock = blocked ?? (dirty ? "Save your changes before requesting a publish." : deleted ? "This item is deleted." : !pending ? "There is nothing new to publish." : null);
  const active = flow !== null && (flow.phase.phase === "pending" || flow.phase.phase === "approved_publishing" || flow.phase.phase === "verifying");

  // ── Poll the approval while it is in flight ────────────────────────────────────────────────────
  const approvalId = flow && (flow.phase.phase === "pending" || flow.phase.phase === "approved_publishing") ? flow.approvalId : null;
  const flowKind = flow?.kind ?? null;
  const flowVersion = flow ? flow.version : null;

  const settle = useCallback(async (kind: "publish" | "rebuild", id: string, requested: number | null, phase: Extract<RequestPhase, { phase: "executed" }>) => {
    setFlow({ kind, approvalId: id, version: requested, phase: { phase: "verifying" } });
    if (kind === "rebuild") {
      setFlow({ kind: "rebuild", approvalId: id, version: null, phase: { phase: "rebuild_approved", approvedBy: phase.decidedByName } });
      setWatchBuild(true);
      return;
    }
    const head = await getItemHeadAction(scope, item.itemId);
    if (!mounted.current) return;
    if (head.kind === "ok") {
      onItemChanged(head.data.item);
      const confirmed = requested !== null && head.data.item.publishedVersion === requested;
      setFlow({ kind: "publish", approvalId: id, version: requested ?? head.data.item.publishedVersion, phase: { phase: confirmed ? "published" : "published_unconfirmed", approvedBy: phase.decidedByName } });
      if (confirmed) { setWatchBuild(true); setStagingStale(false); }
    } else {
      if (head.kind === "unavailable") onUnavailable(head.reason);
      setFlow({ kind: "publish", approvalId: id, version: requested, phase: { phase: "published_unconfirmed", approvedBy: phase.decidedByName } });
    }
  }, [scope, item.itemId, onItemChanged, onUnavailable]);

  useEffect(() => {
    if (!approvalId || !flowKind) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await pollApprovalAction(scope, approvalId);
      if (cancelled || !mounted.current) return;
      if (r.kind === "ok") {
        const phase = phaseOf(r.data);
        if (phase.phase === "executed") { void settle(flowKind, approvalId, flowVersion, phase); return; }
        setFlow({ kind: flowKind, approvalId, version: flowVersion, phase });
        if (phase.phase === "rejected" || phase.phase === "failed" || phase.phase === "withdrawn") return;
      } else {
        setFlow((f) => (f ? { ...f, refreshFailed: failureCopy(r) } : f));
      }
      timer = setTimeout(tick, APPROVAL_POLL_MS);
    };
    timer = setTimeout(tick, APPROVAL_POLL_MS);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [scope, approvalId, flowKind, flowVersion, settle]);

  // ── Poll the staging build until it is live / unverified / failed ──────────────────────────────
  useEffect(() => {
    if (!watchBuild) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await pollBuildStatusAction(scope);
      if (cancelled || !mounted.current) return;
      if (r.kind === "ok") {
        setBuild(r.data); setBuildNote(null); setStagingStale(r.data.stagingStale);
        const st = r.data.build?.state;
        if (st === "live" || st === "unverified" || st === "failed") { setWatchBuild(false); return; }
      } else {
        setBuildNote(r.kind === "not_enabled" ? "Staging rebuild status isn't available on this deployment yet, so this page cannot say whether staging shows the change." : failureCopy(r));
        if (r.kind === "unavailable" && r.code !== "contract_drift") onUnavailable(r.reason);
        if (r.kind === "not_enabled") { setWatchBuild(false); return; }
      }
      timer = setTimeout(tick, BUILD_POLL_MS);
    };
    timer = setTimeout(tick, 600);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [watchBuild, scope, onUnavailable]);

  /** True (and handled) when `r` is an unknown-outcome write: never rendered as success or as a plain failure. */
  const unknownOutcome = (r: Exclude<WdResult<unknown>, { kind: "ok" }>, what: string): boolean => {
    if (!isOutcomeUnknown(r)) return false;
    if (onUnconfirmed) onUnconfirmed(what);
    else setMessage({ tone: "bad", text: unconfirmedCopy(what) });
    return true;
  };

  // ── Actions ────────────────────────────────────────────────────────────────────────────────────
  const requestPublish = async () => {
    setBusy("request"); setMessage(null);
    const r = await requestPublishAction(scope, [{ itemId: item.itemId, version }]);
    if (!mounted.current) return;
    setBusy(null);
    if (r.kind === "ok") {
      setFlow({ kind: "publish", approvalId: r.data.approvalId, version, phase: { phase: "pending", approvalId: r.data.approvalId } });
    } else if (!unknownOutcome(r, "the publish request")) {
      if (r.kind === "unavailable" && r.code !== "contract_drift") onUnavailable(r.reason);
      setMessage({ tone: "bad", text: `Couldn't file the publish request. ${failureCopy(r)}` });
    }
  };

  const withdraw = async () => {
    if (!flow) return;
    setBusy("withdraw"); setMessage(null);
    const r = await withdrawPublishRequestAction(scope, flow.approvalId);
    if (!mounted.current) return;
    setBusy(null);
    if (r.kind === "ok") { setFlow(null); setMessage({ tone: "info", text: `Request ${shortId(flow.approvalId)} withdrawn.` }); return; }
    if (unknownOutcome(r, "the withdrawal")) return;
    setMessage({
      tone: "bad",
      text: r.kind === "not_enabled"
        ? `Withdraw isn't available yet. Ask an approver to reject request ${shortId(flow.approvalId)}.`
        : `Couldn't withdraw the request. ${failureCopy(r)}`,
    });
  };

  const unpublish = async () => {
    setBusy("unpublish"); setMessage(null); setConfirmUnpublish(false);
    const expected = item.publishedVersion;
    if (expected === null) { setBusy(null); return; }
    const r = await unpublishItemAction(scope, item.itemId, expected);
    if (!mounted.current) return;
    setBusy(null);
    if (r.kind === "ok") {
      onItemChanged(r.data.item);
      setStagingStale(true);
      setMessage({ tone: "ok", text: "Unpublished from WebDesk." });
    } else if (!unknownOutcome(r, "the unpublish")) {
      if (r.kind === "unavailable" && r.code !== "contract_drift") onUnavailable(r.reason);
      setMessage({ tone: "bad", text: `Couldn't unpublish. ${failureCopy(r)}` });
    }
  };

  const requestRebuild = async () => {
    setBusy("rebuild"); setMessage(null);
    const r = await requestRebuildAction(scope);
    if (!mounted.current) return;
    setBusy(null);
    if (r.kind === "ok") {
      setFlow({ kind: "rebuild", approvalId: r.data.approvalId, version: null, phase: { phase: "pending", approvalId: r.data.approvalId } });
    } else if (!unknownOutcome(r, "the rebuild request")) {
      setMessage({
        tone: "bad",
        text: r.kind === "not_enabled" ? "Requesting a rebuild isn't available on this deployment yet."
          // 503 webdesk_not_configured: the site has no staging rebuild target, so nothing was filed. `reason` is the BFF's
          // own token for it; the lib's result (`unavailable/editorial_unavailable`) is deliberately left as it is.
          : r.kind === "unavailable" && r.reason === REBUILD_NOT_CONFIGURED_REASON ? REBUILD_NOT_CONFIGURED_COPY
          : `Couldn't request a rebuild. ${failureCopy(r)}`,
      });
    }
  };

  const phase = flow?.phase;
  const refreshFailed = flow?.refreshFailed;
  const buildState = build?.build?.state ?? null;

  return (
    <section className="wc-side-card wc-publish" aria-label="Publishing" data-testid="publish-bar">
      <h3>Publishing</h3>

      <p className="wc-publish__line" data-testid="publish-state">
        {item.deletedAt ? "Deleted"
          : live ? `Live · v${item.publishedVersion}`
          : item.publishState === "unpublished" ? "Unpublished"
          : item.publishState === "scheduled" ? "Scheduled"
          : "Draft · never published"}
      </p>
      <p className="wc-publish__sub">
        Head v{item.headVersion} · {publishStateLabel(item.publishState)}
        {live && pending ? " · has unpublished changes" : ""}
      </p>

      {pendingProblem && !flow && (
        <p className="wc-publish__sub" role="note">Couldn&apos;t check for an existing publish request ({pendingProblem}).</p>
      )}

      {/* ── the request's own phase ───────────────────────────────────────────────────────────── */}
      <div aria-live="polite" data-testid="publish-flow">
        {phase?.phase === "pending" && flow && (
          <div className="wc-banner wc-banner--info" data-testid="awaiting-approval">
            <span className="wc-banner__body">
              <strong>Awaiting approval {shortId(flow.approvalId)}</strong>
              <br />{flow.kind === "rebuild" ? "A rebuild of the staging site was requested." : `Publish of v${flow.version ?? "?"} was requested.`} An approver must decide it.
              {refreshFailed && <><br /><span className="wc-muted">Couldn&apos;t refresh the approval ({refreshFailed}) — retrying.</span></>}
            </span>
            <span className="wc-publish__actions">
              <Link className="lux-btn lux-btn--ghost lux-btn--sm" href={`/approvals/${flow.approvalId}`}>Open approval</Link>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={withdraw} disabled={busy !== null}>Withdraw</button>
            </span>
          </div>
        )}
        {phase?.phase === "approved_publishing" && flow && (
          <div className="wc-banner wc-banner--info" data-testid="approved-publishing">
            <span className="wc-banner__body"><strong>Approved{phase.decidedByName ? ` by ${phase.decidedByName}` : ""}</strong> — publishing {shortId(flow.approvalId)}…</span>
          </div>
        )}
        {phase?.phase === "verifying" && <div className="wc-banner wc-banner--info"><span className="wc-banner__body">Confirming with WebDesk…</span></div>}
        {phase?.phase === "rejected" && flow && (
          <div className="wc-banner wc-banner--bad" data-testid="request-rejected">
            <span className="wc-banner__body"><strong>Rejected</strong>{phase.decidedByName ? ` by ${phase.decidedByName}` : ""} — request {shortId(flow.approvalId)} was not approved. Nothing was published.</span>
            {flow.kind === "publish" && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={requestPublish} disabled={busy !== null || requestBlock !== null}>Request again</button>}
          </div>
        )}
        {phase?.phase === "withdrawn" && flow && (
          <div className="wc-banner wc-banner--info" data-testid="request-withdrawn">
            <span className="wc-banner__body"><strong>Withdrawn</strong> — request {shortId(flow.approvalId)} was withdrawn by its requester. Nothing was published.</span>
            {flow.kind === "publish" && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={requestPublish} disabled={busy !== null || requestBlock !== null}>Request again</button>}
          </div>
        )}
        {phase?.phase === "failed" && flow && (
          <div className="wc-banner wc-banner--bad" data-testid="request-failed">
            <span className="wc-banner__body"><strong>Approved, but it failed.</strong> {phase.reason} Request {shortId(flow.approvalId)}.</span>
            {flow.kind === "publish" && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={requestPublish} disabled={busy !== null || requestBlock !== null}>Request again</button>}
          </div>
        )}
        {phase?.phase === "published" && flow && (
          <div className="wc-banner wc-banner--ok" data-testid="published">
            <span className="wc-banner__body"><strong>Published v{flow.version}</strong>{phase.approvedBy ? ` · approved by ${phase.approvedBy}` : ""}</span>
          </div>
        )}
        {phase?.phase === "published_unconfirmed" && flow && (
          <div className="wc-banner wc-banner--warn" data-testid="published-unconfirmed">
            <span className="wc-banner__body"><strong>Approved, but WebDesk doesn&apos;t show v{flow.version} as live yet.</strong> The publish may still be in flight — refresh the page to check.</span>
          </div>
        )}
        {phase?.phase === "rebuild_approved" && (
          <div className="wc-banner wc-banner--info"><span className="wc-banner__body"><strong>Rebuild approved</strong>{phase.approvedBy ? ` by ${phase.approvedBy}` : ""}.</span></div>
        )}
      </div>

      {message && (
        <div className={`wc-banner wc-banner--${message.tone}`} role={message.tone === "bad" ? "alert" : "status"} data-testid="publish-message">
          <span className="wc-banner__body">{message.text}</span>
        </div>
      )}

      {/* ── actions ───────────────────────────────────────────────────────────────────────────── */}
      <div className="wc-publish__actions">
        <button
          type="button" className="lux-btn lux-btn--solid lux-btn--sm" data-testid="request-publish"
          disabled={busy !== null || active || requestBlock !== null}
          onClick={requestPublish}
          aria-describedby={requestBlock ? "publish-block-reason" : undefined}
        >
          {busy === "request" ? "Requesting…" : "Request publish"}
        </button>
        {live && !confirmUnpublish && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="unpublish" disabled={busy !== null || blocked !== null} onClick={() => setConfirmUnpublish(true)}>Unpublish</button>
        )}
      </div>
      {requestBlock && <p id="publish-block-reason" className="wc-publish__sub" data-testid="publish-block-reason">{requestBlock}</p>}
      {confirmUnpublish && (
        <div className="wc-banner wc-banner--warn">
          <span className="wc-banner__body">Take v{item.publishedVersion} off WebDesk now? This does not wait for an approval.</span>
          <span className="wc-publish__actions">
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" data-testid="confirm-unpublish" onClick={unpublish}>Unpublish</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmUnpublish(false)}>Cancel</button>
          </span>
        </div>
      )}
      <p className="wc-publish__sub">Publishing is approved separately, and the approval also rebuilds the staging site.</p>

      {/* ── staging ───────────────────────────────────────────────────────────────────────────── */}
      <div aria-live="polite" data-testid="staging-state">
        {buildState === "rebuilding" && (
          <div className="wc-banner wc-banner--info" data-testid="rebuilding">
            <span className="wc-banner__body"><strong>Rebuilding staging…</strong> Started {formatDateTime(build?.build?.requestedAt)}.<progress className="wc-progress" aria-label="Staging rebuild in progress" /></span>
          </div>
        )}
        {buildState === "live" && (
          <div className="wc-banner wc-banner--ok" data-testid="live-on-staging">
            <span className="wc-banner__body"><strong>Live on staging</strong>{build?.build?.verifiedAt ? ` · confirmed ${formatDateTime(build.build.verifiedAt)}` : ""}.{" "}
              {(stagingUrl ?? build?.build?.stagingUrl) && <a href={(stagingUrl ?? build?.build?.stagingUrl) as string} target="_blank" rel="noopener noreferrer">View on staging</a>}</span>
          </div>
        )}
        {buildState === "unverified" && (
          <div className="wc-banner wc-banner--warn" data-testid="rebuild-unverified">
            <span className="wc-banner__body"><strong>Rebuild unverified.</strong> The content is published in WebDesk, but the staging site never confirmed it — treat staging as not updated until you have checked it.{" "}
              {(stagingUrl ?? build?.build?.stagingUrl) && <a href={(stagingUrl ?? build?.build?.stagingUrl) as string} target="_blank" rel="noopener noreferrer">Open staging</a>}</span>
          </div>
        )}
        {buildState === "failed" && (
          <div className="wc-banner wc-banner--bad" data-testid="rebuild-failed"><span className="wc-banner__body"><strong>The staging rebuild failed.</strong> Staging still shows the previous content.</span></div>
        )}
        {stagingStale && buildState !== "rebuilding" && (
          <div className="wc-banner wc-banner--warn" data-testid="staging-stale">
            <span className="wc-banner__body"><strong>Unpublished from WebDesk</strong> — the staging site drops it at the next rebuild.</span>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="request-rebuild" onClick={requestRebuild} disabled={busy !== null || active || blocked !== null}>Request rebuild</button>
          </div>
        )}
        {buildNote && !watchBuild && buildState === null && <p className="wc-publish__sub" data-testid="build-unavailable">{buildNote}</p>}
        {stagingUrl && buildState === null && live && <p className="wc-publish__sub"><a href={stagingUrl} target="_blank" rel="noopener noreferrer">View on staging</a></p>}
      </div>
    </section>
  );
}
