"use client";
import { useRef, useState } from "react";
import { Card } from "@/components/ui";
import { saveGoogleAdsAction, saveLinkedinPartnerIdAction } from "@/lib/trackingTagsActions";
import {
  ADS_CONVERSION_KEYS, ADS_CONVERSION_LABELS, ADS_HELP, TAGS_HELP, adsIdsToText, checkGoogleAds, checkPartnerId,
  type AdsConversionKey, type GoogleAds, type TrackingTagsView,
} from "@/lib/trackingTagsModel";
import "./analytics.css";

// Website -> Analytics -> site -> "Tracking tags" (M5-P4, WSK-D92). Shows the site's LinkedIn partner id (or "Not set"), where it is stored
// and, for a viewer who may change it, an input with Save and Clear. Everything that is not a stored value is words in its place: a read
// that failed, a site with no build repository, GitHub unable to answer. "Not set" is drawn ONLY for an answer that said so; a failed read
// never shows it (an empty value is a claim). Nothing is optimistic: the value shown after a save is the one the server answered with.
// A change reaches the site only at its next rebuild, and the card says so.
// M5-P4g adds the Google Ads section under LinkedIn: the tag ids, four conversion fields and one Save, checked on the client with the
// server's rules; without `canEdit && canManage` it is read-only (values or "Not set"). It is shown in Website -> Analytics and in the SEO
// workspace on each client's engagement page.

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
            <GoogleAdsSection
              propertyId={propertyId} webdeskTenant={webdeskTenant} site={site} initial={read.data.googleAds}
              editable={canEdit && read.data.canManage}
            />
          </>
        )}
        {msg ? <p className={msg.tone === "ok" ? "wa-tags__ok" : "wa-range__err"} role={msg.tone === "ok" ? "status" : "alert"} data-testid={`tracking-tags-${msg.tone}`}>{msg.text}</p> : null}
        <p className="wa-foot" data-testid="tracking-tags-help">{TAGS_HELP}</p>
      </div>
    </Card>
  );
}

const emptyConversions = (): Record<AdsConversionKey, string> => ({ lead: "", whatsapp: "", phone: "", email: "" });
const conversionsDraft = (c: GoogleAds["conversions"]): Record<AdsConversionKey, string> => ({ ...emptyConversions(), ...c });

/** The Google Ads section: ids + four conversions, one Save. `initial` is what the server read; the value shown after a save is the one it answered. */
function GoogleAdsSection({ propertyId, webdeskTenant, site, initial, editable }: {
  propertyId: string; webdeskTenant: string; site: string; initial: GoogleAds; editable: boolean;
}) {
  const [stored, setStored] = useState<GoogleAds>(initial);
  const [ids, setIds] = useState(adsIdsToText(initial.ids));
  const [conv, setConv] = useState(conversionsDraft(initial.conversions));
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const save = async () => {
    if (inflight.current) return;
    const v = checkGoogleAds({ ids, conversions: conv });
    if (!v.ok) { setMsg({ tone: "bad", text: v.message }); return; }
    inflight.current = true; setBusy(true); setMsg(null);
    try {
      const r = await saveGoogleAdsAction({ propertyId, webdeskTenant, site, ids, conversions: conv });
      if (r.ok) {
        setStored(r.googleAds);
        setIds(adsIdsToText(r.googleAds.ids));
        setConv(conversionsDraft(r.googleAds.conversions));
        setMsg({ tone: "ok", text: r.message });
      } else setMsg({ tone: "bad", text: r.message });
    } catch {
      setMsg({ tone: "bad", text: "Google Ads could not be saved just now. Nothing was changed. Try again in a moment." });
    } finally { inflight.current = false; setBusy(false); }
  };

  return (
    <div className="wa-tags__ads" data-testid="google-ads">
      <h3 className="wa-tags__sub">Google Ads</h3>
      {editable ? (
        <div className="wa-tags__adsform" data-testid="google-ads-form">
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="wa-ads-ids">Google Ads tag ids</label>
            <textarea
              id="wa-ads-ids" className="lux-field__control" rows={2} autoComplete="off" spellCheck={false} maxLength={400}
              value={ids} onChange={(e) => setIds(e.target.value)} placeholder="AW-123456789"
            />
            <span className="wa-foot">Separate ids with commas or new lines. Up to 5.</span>
          </div>
          {ADS_CONVERSION_KEYS.map((k) => (
            <div className="lux-field" key={k}>
              <label className="lux-field__label" htmlFor={`wa-ads-${k}`}>{ADS_CONVERSION_LABELS[k]}</label>
              <input
                id={`wa-ads-${k}`} className="lux-field__control" autoComplete="off" spellCheck={false} maxLength={120}
                value={conv[k]} onChange={(e) => setConv((c) => ({ ...c, [k]: e.target.value }))} placeholder="AW-123456789/AbCdEf"
              />
            </div>
          ))}
          <div className="wa-tags__actions">
            <button type="button" className="lux-btn lux-btn--solid lux-btn--md" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save Google Ads"}</button>
          </div>
        </div>
      ) : (
        <div data-testid="google-ads-values">
          <p className="wa-tags__row">
            <span className="wa-tags__label">Tag ids</span>{" "}
            <strong data-testid="google-ads-ids">{stored.ids.length ? stored.ids.join(", ") : "Not set"}</strong>
          </p>
          {ADS_CONVERSION_KEYS.map((k) => (
            <p className="wa-tags__row" key={k}>
              <span className="wa-tags__label">{ADS_CONVERSION_LABELS[k]}</span>{" "}
              <strong data-testid={`google-ads-${k}`}>{stored.conversions[k] ?? "Not set"}</strong>
            </p>
          ))}
        </div>
      )}
      {msg ? <p className={msg.tone === "ok" ? "wa-tags__ok" : "wa-range__err"} role={msg.tone === "ok" ? "status" : "alert"} data-testid={`google-ads-${msg.tone}`}>{msg.text}</p> : null}
      <p className="wa-foot" data-testid="google-ads-help">{ADS_HELP}</p>
    </div>
  );
}
