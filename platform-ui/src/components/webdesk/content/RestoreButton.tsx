"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { restoreVersionAction, type SiteScope } from "@/lib/webdeskContentActions";
import "./content.css";

/** "Restore as draft": creates a NEW draft version from an old one (§3.1 `content.restoreVersion` —
 *  medium, never live). Two-step, because it moves the head. A 409 means the head moved since this
 *  page loaded; the message says so instead of retrying silently. */
export function RestoreButton({ scope, itemId, version, baseVersion, editorHref }: {
  scope: SiteScope; itemId: string; version: number; baseVersion: number; editorHref: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setError(null);
    const r = await restoreVersionAction(scope, itemId, version, baseVersion, `Restored from v${version}`);
    setBusy(false);
    if (r.kind === "ok") { router.push(editorHref); return; }
    setConfirming(false);
    setError(
      r.kind === "conflict" ? (r.slug === "version-conflict" ? "The item changed since this page loaded — reload the history and try again." : r.message)
      : r.kind === "forbidden" ? "You don't have permission to restore versions."
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
