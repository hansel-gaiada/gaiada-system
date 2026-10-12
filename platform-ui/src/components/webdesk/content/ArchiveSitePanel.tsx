"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { requestSiteArchiveAction, type SiteScope } from "@/lib/webdeskContentActions";
import { ARCHIVE_SITE_COPY, archiveFailureCopy } from "@/lib/webdeskContentModel";
import "./content.css";

// "Archive this site" — the site overview's small danger section, under "API keys".
//
// WHAT FILING MEANS. Nothing is archived here. The BFF files ONE approval (HIGH impact, always WS4-gated); a DIFFERENT authorised user
// approves it, and only then does the ERP tell WebDesk to archive. So the only honest success copy is "Archive requested — waiting for
// approval", never "Site archived". Archiving cannot be undone (WebDesk has no un-archive), so the click opens a confirm step that says
// what it does and that it needs approval; the request is only sent from that second step.
//
// WHO SEES IT. `allowed` is the page's `can(me, "webdev.promote", company)` — the UI mirror of Cerbos `promote` on
// `webdev_provisioned_site`, the BFF's gate. A user who cannot promote sees NOTHING here. That is cosmetic: the BFF's `authorize()` is the
// authority. An already-archived site shows one sentence saying so (to anyone who can see the page) and no control.

type Message =
  | { tone: "ok" | "info"; text: string; approvalId: string }
  | { tone: "bad"; text: string };

export function ArchiveSitePanel({
  allowed, archived, siteName, scope,
}: {
  allowed: boolean;
  archived: boolean;
  siteName: string;
  scope: SiteScope;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const mounted = useRef(true);
  // A ref, not `busy`: two submits in the same tick would both read `busy === false`.
  const inflight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (archived) {
    return (
      <section className="wc-keys" aria-label="Site archived" data-testid="archive-site-archived">
        <div className="wc-banner wc-banner--info" role="status"><span className="wc-banner__body">{ARCHIVE_SITE_COPY.archivedNote}</span></div>
      </section>
    );
  }
  if (!allowed) return null;

  const file = async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true); setMessage(null);
    const r = await requestSiteArchiveAction(scope);
    inflight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setConfirming(false);
    if (r.kind === "ok") {
      setMessage(r.data.alreadyPending
        ? { tone: "info", text: ARCHIVE_SITE_COPY.alreadyPending, approvalId: r.data.approvalId }
        : { tone: "ok", text: ARCHIVE_SITE_COPY.filed, approvalId: r.data.approvalId });
    } else {
      setMessage({ tone: "bad", text: archiveFailureCopy(r) });
    }
  };

  return (
    <section className="wc-keys" aria-labelledby="wc-archive-h" data-testid="archive-site">
      <h2 id="wc-archive-h" className="wc-group-head">{ARCHIVE_SITE_COPY.heading}</h2>
      <p className="wc-muted" style={{ margin: 0 }} data-testid="archive-site-explain">{ARCHIVE_SITE_COPY.explain}</p>
      {!confirming ? (
        <div>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setConfirming(true); setMessage(null); }} data-testid="archive-site-open">
            {ARCHIVE_SITE_COPY.button}
          </button>
        </div>
      ) : (
        <div className="wc-banner wc-banner--warn" role="alertdialog" aria-labelledby="wc-archive-confirm-h" aria-describedby="wc-archive-confirm-d" data-testid="archive-site-confirm">
          <div className="wc-banner__body">
            <strong id="wc-archive-confirm-h">{ARCHIVE_SITE_COPY.confirmTitle}</strong>
            <div id="wc-archive-confirm-d">
              <p style={{ margin: "6px 0" }}>Site: <strong data-testid="archive-site-name">{siteName}</strong></p>
              <ul style={{ margin: "6px 0", paddingLeft: 18 }} data-testid="archive-site-consequences">
                {ARCHIVE_SITE_COPY.consequences.map((line) => <li key={line}>{line}</li>)}
              </ul>
              <p style={{ margin: "6px 0 0" }}>{ARCHIVE_SITE_COPY.confirmBody}</p>
            </div>
          </div>
          <span className="wc-publish__actions">
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={file} disabled={busy} data-testid="archive-site-confirm-submit">
              {busy ? "Requesting…" : ARCHIVE_SITE_COPY.confirm}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(false)} disabled={busy} data-testid="archive-site-cancel">
              {ARCHIVE_SITE_COPY.cancel}
            </button>
          </span>
        </div>
      )}
      {message && (
        <div className={`wc-banner wc-banner--${message.tone}`} role={message.tone === "bad" ? "alert" : "status"} data-testid="archive-site-message">
          <span className="wc-banner__body">{message.text}</span>
          {"approvalId" in message && <Link className="lux-btn lux-btn--ghost lux-btn--sm" href={`/approvals/${encodeURIComponent(message.approvalId)}`}>{ARCHIVE_SITE_COPY.viewRequest}</Link>}
        </div>
      )}
    </section>
  );
}
