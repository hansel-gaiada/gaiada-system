"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Button, Toast } from "@/components/ui";
import {
  getDiscoveryPreviewAction,
  fillFromDiscoveryAction,
  type DiscoveryPreview,
  type DiscoveryFillOutcome,
} from "@/lib/clientCentreDiscoveryActions";

// PV6-04 (CC-D6): staff-only "Fill from discovery answers (N fields)" on Business details. Shown only
// when the server's preview says the client has discovery answers AND at least one empty field would
// be filled; it never overwrites. The client id comes from the staff route (/clients/:id/profile/...),
// so Business details needs no new prop.
export function DiscoveryFillButton({
  isPortal,
  canEdit,
  previewAction = getDiscoveryPreviewAction,
  fillAction = fillFromDiscoveryAction,
  reload = () => window.location.reload(),
}: {
  isPortal: boolean;
  canEdit: boolean;
  previewAction?: (clientId: string) => Promise<DiscoveryPreview>;
  fillAction?: (clientId: string) => Promise<DiscoveryFillOutcome>;
  reload?: () => void;
}) {
  const pathname = usePathname();
  const clientId = /^\/clients\/([^/]+)\/profile(?:\/|$)/.exec(pathname ?? "")?.[1] ?? null;
  const enabled = !isPortal && canEdit && clientId !== null;
  const [preview, setPreview] = useState<DiscoveryPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !clientId) return;
    let live = true;
    previewAction(clientId).then((p) => { if (live) setPreview(p); }, () => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [enabled, clientId, previewAction]);

  if (!enabled || !clientId) return null;
  const n = preview?.fillable.length ?? 0;

  async function run() {
    if (!clientId) return;
    setBusy(true);
    const r = await fillAction(clientId);
    setBusy(false);
    if (!r.ok) { setMessage(r.error ?? "Could not fill from the discovery answers."); return; }
    const count = r.filled?.length ?? 0;
    setMessage(count === 1 ? "1 field filled from the discovery answers." : `${count} fields filled from the discovery answers.`);
    setPreview({ available: true, fillable: [] });
    // The form's draft is seeded from the page's profile once, so reload to show the filled values
    // (nothing is lost: edits autosave, and the fill itself is already saved server-side).
    if (count > 0) setTimeout(() => reload(), 1200);
  }

  return (
    <>
      {preview?.available && n > 0 && (
        <p className="cc-lede" style={{ marginBottom: 12 }}>
          <Button variant="ghost" onClick={run} disabled={busy}>
            {busy ? "Filling…" : `Fill from discovery answers (${n} ${n === 1 ? "field" : "fields"})`}
          </Button>
          <span className="cc-field__help" style={{ marginLeft: 8 }}>Only empty fields are filled; nothing is overwritten.</span>
        </p>
      )}
      {message && <Toast message={message} />}
    </>
  );
}
