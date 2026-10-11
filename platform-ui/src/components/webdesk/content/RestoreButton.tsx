"use client";
import { useState } from "react";
import { restoreVersionAndOpenAction, type SiteScope, type WriteFailure } from "@/lib/webdeskContentActions";
import { isNextRedirect, isOutcomeUnknown, unconfirmedCopy } from "@/lib/webdeskContentModel";
import { clientRefusal } from "@/lib/webdeskClientCopy";
import "./content.css";

/** "Restore as draft": creates a NEW draft version from an old one (§3.1 `content.restoreVersion` —
 *  medium, never live). Two-step, because it moves the head. A 409 means the head moved since this
 *  page loaded; the message says so instead of retrying silently. */
export function RestoreButton({ scope, itemId, version, baseVersion, editorHref, restoreAndOpen, clientMode = false }: {
  scope: SiteScope; itemId: string; version: number; baseVersion: number; editorHref: string;
  /** WSK-49d: the portal's own restore (a server action bound to the client). Absent = the staff action, as before. */
  restoreAndOpen?: (scope: SiteScope, itemId: string, version: number, baseVersion: number, editorHref: string, note?: string) => Promise<WriteFailure>;
  /** WSK-49d: a client editor's refusals, in the client's words (`lib/webdeskClientCopy.ts`). */
  clientMode?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setError(null);
    // Success opens the editor from the SERVER (`restoreVersionAndOpenAction` redirects; a client push here was
    // sometimes dropped by the router, see webdeskContentActions.ts). Only a failure comes back, typed as before.
    let r: Awaited<ReturnType<typeof restoreVersionAndOpenAction>>;
    try {
      r = await (restoreAndOpen ?? restoreVersionAndOpenAction)(scope, itemId, version, baseVersion, editorHref, `Restored from v${version}`);
    } catch (e) {
      if (isNextRedirect(e)) return; // restored, and already on the editor
      throw e;
    }
    setBusy(false);
    setConfirming(false);
    if (clientMode) { setError(clientRefusal(r, "restore").text); return; }
    setError(
      r.kind === "conflict" ? (r.slug === "version-conflict" ? "The item changed since this page loaded — reload the history and try again." : r.message)
      : r.kind === "forbidden" ? "You don't have permission to restore versions."
      : isOutcomeUnknown(r) ? unconfirmedCopy("the restore")
      : r.kind === "unavailable" ? "WebDesk can't be reached right now. Nothing was restored."
      : r.kind === "invalid" ? r.message
      : "Couldn't restore that version.",
    );
  };

  if (!confirming) {
    return (
      <>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(true)} data-testid={`restore-${version}`}>Restore as draft</button>
        {error && <span className="lux-field__error" role="alert">{error}</span>}
      </>
    );
  }
  return (
    <span className="wc-publish__actions">
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={go} disabled={busy} data-testid={`confirm-restore-${version}`}>{busy ? "Restoring…" : `Restore v${version} as the new draft`}</button>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
    </span>
  );
}
