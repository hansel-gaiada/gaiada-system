"use client";
import { useState } from "react";
import { listQuarantineAction, reviewUploadAction } from "@/lib/webdeskMediaReviewActions";
import { authorLabel, type WdResult } from "@/lib/webdeskContentModel";
import { reviewRefusalCopy, uploadFacts, type QuarantineBody, type QuarantinedUpload, type ReviewDecision } from "@/lib/webdeskMediaReviewModel";
import { formatDateTime } from "@/lib/format";
import "../editorial/editorial.css";

// `writers/uploads/[tenant]/[site]` -- the contributor upload quarantine's review desk (M5-W1q, WSK-D84). A freelance writer's upload is held
// here: it has passed the malware scan but WebDesk serves it nowhere until a staff editor accepts it. Accept makes it part of the library;
// Reject refuses it for good (the file is deleted once its retention lapses). The buttons follow the BFF's own `allowed.review` for THAT
// upload (false for the uploader themselves, null when Cerbos could not answer: the server's refusal is then the fallback). A refusal is
// said in words and the list is re-read, so the screen never claims a state the server does not hold.

type Msg = { tone: "ok" | "bad" | "warn"; text: string };

export function QuarantinePanel({
  scope, initial, people,
}: {
  scope: { tenantSlug: string; siteId: string };
  initial: QuarantineBody;
  /** The company's people (id -> display name); a freelance writer is usually not in it, and then the row says so. */
  people: Record<string, string>;
}) {
  const [uploads, setUploads] = useState<QuarantinedUpload[]>(initial.assets);
  const [hasMore, setHasMore] = useState(initial.page.hasMore);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  const refresh = async (keepMsg = false): Promise<void> => {
    let r: WdResult<QuarantineBody>;
    try { r = await listQuarantineAction(scope); } catch { r = { kind: "unavailable", code: "network", reason: "network" }; }
    if (r.kind === "ok") { setUploads(r.data.assets); setHasMore(r.data.page.hasMore); return; }
    if (!keepMsg) setMsg({ tone: "warn", text: `The decision went through, but the list couldn't be refreshed: ${reviewRefusalCopy(r)}` });
  };

  const decide = async (u: QuarantinedUpload, decision: ReviewDecision) => {
    const id = u.asset.assetId;
    setBusy(id); setMsg(null); setConfirmReject(null);
    let r: WdResult<{ alreadyDecided: boolean }>;
    try { r = await reviewUploadAction(scope, id, decision, `review-${id}-${decision}`); } catch { r = { kind: "unavailable", code: "network", reason: "network" }; }
    const name = u.asset.title ?? u.asset.originalFilename ?? "The upload";
    if (r.kind === "ok") {
      setMsg({ tone: "ok", text: r.data.alreadyDecided
        ? `${name} had already been ${decision === "accept" ? "accepted" : "rejected"}. Nothing changed.`
        : decision === "accept" ? `${name} is accepted and now part of the library.` : `${name} is rejected. It will not be shown anywhere.` });
      await refresh();
    } else {
      setMsg({ tone: "bad", text: reviewRefusalCopy(r) });
      await refresh(true); // whatever the refusal, show what the server now holds (never a stale row that invites a second click)
    }
    setBusy(null);
  };

  return (
    <div className="wc-page" data-testid="quarantine-panel">
      {msg && (
        <div className={`wc-banner wc-banner--${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"} data-testid={`quarantine-${msg.tone}`}>
          <span className="wc-banner__body">{msg.text}</span>
        </div>
      )}
      <p className="wc-muted" data-testid="quarantine-note">
        These files were uploaded by freelance writers. They have passed the malware scan, but nobody can see them on the website until you accept them.
        The file itself isn&apos;t shown here: check the title, type and who sent it, and reject anything you don&apos;t recognise.
      </p>

      {uploads.length === 0 ? (
        <p className="wc-muted" data-testid="quarantine-empty">No uploads are waiting for review on this site.</p>
      ) : (
        <div className="wc-scroll">
          <table className="wc-table" data-testid="quarantine-table">
            <thead>
              <tr><th scope="col">Upload</th><th scope="col">Details</th><th scope="col">Sent by</th><th scope="col">Sent</th><th scope="col"><span className="wc-sr">Actions</span></th></tr>
            </thead>
            <tbody>
              {uploads.map((u) => {
                const id = u.asset.assetId;
                const off = busy !== null || u.allowedReview === false;
                const sender = u.asset.createdBy ? authorLabel(u.asset.createdBy, people) : "Unknown";
                return (
                  <tr key={id} data-testid="quarantine-row">
                    <td>{u.asset.title ?? u.asset.originalFilename ?? "Untitled"}{u.asset.title && u.asset.originalFilename ? <><br /><span className="wc-muted">{u.asset.originalFilename}</span></> : null}</td>
                    <td>{uploadFacts(u.asset)}</td>
                    <td>{sender}</td>
                    <td>{formatDateTime(u.asset.createdAt)}</td>
                    <td>
                      {u.allowedReview === false ? (
                        <span className="wc-muted" data-testid="quarantine-not-allowed">You can&apos;t review this upload{u.asset.createdBy ? ". Someone else has to." : "."}</span>
                      ) : confirmReject === id ? (
                        <span className="we-actions">
                          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => void decide(u, "reject")} disabled={off} data-testid="quarantine-reject-confirm">Reject for good</button>
                          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmReject(null)}>Keep waiting</button>
                        </span>
                      ) : (
                        <span className="we-actions">
                          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => void decide(u, "accept")} disabled={off} data-testid="quarantine-accept">Accept</button>
                          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmReject(id)} disabled={off} data-testid="quarantine-reject">Reject…</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && <p className="wc-muted" data-testid="quarantine-more">There are more uploads than fit here. Decide these and the next ones appear.</p>}
    </div>
  );
}
