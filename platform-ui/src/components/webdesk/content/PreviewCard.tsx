"use client";
import { useEffect, useRef, useState } from "react";
import { previewItemAction, type SiteScope } from "@/lib/webdeskContentActions";
import { previewRefusalCopy, type PreviewLink, type WdResult } from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";

// WSK-46 (owner ruling WSK-D52) — the editor's "Preview" action: an instant preview of the DRAFT on the site's own
// /preview/ page. One click asks the BFF (through a server action) for a one-time link and opens it in a new tab
// (`noopener,noreferrer`).
//
// WHAT THE CONTROL PROMISES, AND WHAT IT NEVER DOES
//   * It previews the last SAVED version (`version`), not unsaved edits: when the form is dirty it says so.
//   * It is disabled in exactly the states Save is disabled in (read-only, stale, unconfirmed): `blocked` is the editor's
//     own reason, shown beside the button (`aria-describedby`), the way PublishBar does.
//   * It never opens a tab it is not sure about: the action's parser (`parsePreviewLink`) accepts only an https link to
//     the site's /preview/ page with the token in the fragment. A refusal is plain words in a notice, never a broken tab:
//     `preview_not_configured` and `preview_page_missing` are explained (nothing was minted), the rest say what to do.
//   * `window.open(..., "noopener,noreferrer")` returns null even when it worked, so a blocked pop-up cannot be detected.
//     The link therefore also stays on screen as an anchor ("Open the preview again") until the editor leaves or it is replaced.
//   * The link is a secret to one draft. It lives only in this component's state: it is never logged, stored or put in the URL
//     of the editor; the expiry is shown as "link valid until …".
//
// A preview is NOT a save and not a publish: it changes no content, so a failure here never flips the editor to stale and
// never touches the user's edits.

type Notice = { tone: "info" | "bad"; text: string };

export function PreviewCard({
  scope, itemId, version, dirty, blocked, preview,
}: {
  scope: SiteScope;
  itemId: string;
  /** The version the editor is on (its last saved head): what the link will show. */
  version: number;
  dirty: boolean;
  /** Why the editor's writes are off (read-only, stale, unconfirmed), or null. Preview is disabled exactly then. */
  blocked: string | null;
  /** WSK-49d: the portal's own call (client mode). Absent = the staff action, as before. */
  preview?: (scope: SiteScope, itemId: string, version: number) => Promise<WdResult<PreviewLink>>;
}) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<PreviewLink | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const click = async () => {
    if (blocked !== null || busy) return;
    setBusy(true); setNotice(null); setLink(null);
    let r: Awaited<ReturnType<typeof previewItemAction>>;
    try {
      r = await (preview ?? previewItemAction)(scope, itemId, version);
    } catch {
      // A rejected server action (the network, a deploy in flight): the same plain words as an unreachable WebDesk.
      if (!mounted.current) return;
      setBusy(false);
      setNotice({ tone: "bad", text: "Couldn't reach WebDesk, so no preview link was made. Try again shortly." });
      return;
    }
    if (!mounted.current) return;
    setBusy(false);
    if (r.kind !== "ok") { setNotice(previewRefusalCopy(r)); return; }
    setLink(r.data);
    window.open(r.data.previewUrl, "_blank", "noopener,noreferrer");
  };

  const why = blocked ?? (dirty ? `Shows the last saved version (v${version}), not your unsaved changes.` : null);

  return (
    <section className="wc-side-card" data-testid="preview-card" aria-labelledby="wc-preview-h">
      <h3 id="wc-preview-h">Preview</h3>
      <p className="wc-publish__sub">See this draft on the site, in a new tab. The link works for a short time.</p>
      <div className="wc-publish__actions">
        <button
          type="button" className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="preview"
          onClick={() => void click()}
          disabled={blocked !== null || busy}
          aria-busy={busy || undefined}
          aria-describedby={why !== null ? "wc-preview-why" : undefined}
        >
          {busy ? "Making the link…" : "Preview draft"}<span className="wc-sr"> (opens in a new tab)</span>
        </button>
      </div>
      {why !== null && <p id="wc-preview-why" className="wc-publish__sub" data-testid="preview-why">{why}</p>}
      {link && (
        <div role="status" data-testid="preview-ready">
          <p className="wc-publish__sub" data-testid="preview-expiry">Link valid until {formatDateTime(link.expiresAt)} · shows v{link.version}</p>
          <p className="wc-publish__sub">
            <a href={link.previewUrl} target="_blank" rel="noopener noreferrer" data-testid="preview-open-again">Open the preview again</a>
          </p>
        </div>
      )}
      {notice && (
        <div className={`wc-banner wc-banner--${notice.tone}`} role={notice.tone === "bad" && !preview ? "alert" : "status"} data-testid="preview-notice" data-tone={notice.tone}>
          <span className="wc-banner__body">{notice.text}</span>
        </div>
      )}
    </section>
  );
}
