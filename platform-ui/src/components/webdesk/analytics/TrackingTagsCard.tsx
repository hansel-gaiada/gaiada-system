"use client";
import { useRef, useState } from "react";
import { Card } from "@/components/ui";
import { saveLinkedinPartnerIdAction } from "@/lib/trackingTagsActions";
import { TAGS_HELP, checkPartnerId, type TrackingTagsView } from "@/lib/trackingTagsModel";
import "./analytics.css";

// Website -> Analytics -> site -> "Tracking tags" (M5-P4, WSK-D92). Shows the site's LinkedIn partner id (or "Not set"), where it is stored
// and, for a viewer who may change it, an input with Save and Clear. Everything that is not a stored value is words in its place: a read
// that failed, a site with no build repository, GitHub unable to answer. "Not set" is drawn ONLY for an answer that said so; a failed read
// never shows it (an empty value is a claim). Nothing is optimistic: the value shown after a save is the one the server answered with.
// A change reaches the site only at its next rebuild, and the card says so.

/** `read` is what the page read: either the view or a sentence. `canEdit` is the viewer's capability (`search.tags.manage`). */
export type TrackingTagsRead = { state: "ok"; data: TrackingTagsView } | { state: "unavailable"; message: string };

export function TrackingTagsCard({ propertyId, webdeskTenant, site, read, canEdit }: {
  propertyId: string; webdeskTenant: string; site: string; read: TrackingTagsRead; canEdit: boolean;
}) {
  const initial = read.state === "ok" && read.data.state === "ok" ? read.data.linkedin.partnerId : null;
  const [stored, setStored] = useState<string | null>(initial);
  const [draft, setDraft] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const run = async (partnerId: string | null) => {
    if (inflight.current) return;
    inflight.current = true; setBusy(true); setMsg(null);
    try {
      const r = await saveLinkedinPartnerIdAction({ propertyId, webdeskTenant, site, partnerId });
      if (r.ok) {
        setStored(r.partnerId);
        setDraft(r.partnerId ?? "");
        setMsg({ tone: "ok", text: r.message });
      } else setMsg({ tone: "bad", text: r.message });
    } catch {
      setMsg({ tone: "bad", text: "The tracking tag could not be saved just now. Nothing was changed. Try again in a moment." });
    } finally { inflight.current = false; setBusy(false); }
  };

  const save = () => {
    const v = checkPartnerId(draft);
    if (!v.ok) { setMsg({ tone: "bad", text: v.message }); return; }
    void run(v.value);
  };

  return (
    <Card title="Tracking tags">
      <div className="wa-tags" data-testid="tracking-tags">
        {read.state === "unavailable" ? (
          <p className="wa-note" role="status" data-testid="tracking-tags-unavailable">{read.message}</p>
        ) : read.data.state !== "ok" ? (
          <p className="wa-note" role="status" data-testid={`tracking-tags-${read.data.state}`}>{read.data.reason}</p>
        ) : (
          <>
            <p className="wa-tags__row">
              <span className="wa-tags__label">LinkedIn partner id</span>{" "}
              <strong data-testid="tracking-tags-value">{stored ?? "Not set"}</strong>
            </p>
            {read.data.target ? (
              <p className="wa-foot" data-testid="tracking-tags-target">
                Stored on {read.data.target.repo} as the repository variable {read.data.target.variable}.
              </p>
            ) : null}
            {canEdit && read.data.canManage ? (
              <div className="wa-tags__form" data-testid="tracking-tags-form">
                <div className="lux-field">
                  <label className="lux-field__label" htmlFor="wa-linkedin-id">LinkedIn partner id</label>
                  <input
                    id="wa-linkedin-id" className="lux-field__control" inputMode="numeric" autoComplete="off" maxLength={40}
                    value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="1234567"
                  />
                </div>
                <div className="wa-tags__actions">
                  <button type="button" className="lux-btn lux-btn--solid lux-btn--md" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--md" onClick={() => void run(null)} disabled={busy || stored === null}>Clear</button>
                </div>
              </div>
            ) : null}
          </>
        )}
        {msg ? <p className={msg.tone === "ok" ? "wa-tags__ok" : "wa-range__err"} role={msg.tone === "ok" ? "status" : "alert"} data-testid={`tracking-tags-${msg.tone}`}>{msg.text}</p> : null}
        <p className="wa-foot" data-testid="tracking-tags-help">{TAGS_HELP}</p>
      </div>
    </Card>
  );
}
