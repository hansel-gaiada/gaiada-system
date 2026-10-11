"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { deleteMediaAction, mediaUsageAction, updateMediaAction, type MediaPatch } from "@/lib/webdeskMediaActions";
import type { SiteScope } from "@/lib/webdeskContentActions";
import type { MediaDriver } from "@/lib/webdeskEditorDriver";
import { authorLabel, isOutcomeUnknown, unconfirmedCopy, type WdResult } from "@/lib/webdeskContentModel";
import {
  altFor, assetLabel, dimensionsLabel, formatBytes, mimeLabel, normalizeTags, previewUrl, usageLabel,
  type MediaAsset, type MediaInUse, type MediaUsage, type MediaUsageItem,
} from "@/lib/webdeskMediaModel";
import { formatDateTime } from "@/lib/format";
import { MediaDialog } from "./MediaDialog";
import { MediaThumb } from "./MediaThumb";
import "./content.css";
import "./media.css";

// The asset detail panel: editable title, per-locale alt text and tags; who uploaded it and when; the canonical URL with a
// Copy button; "Where it's used" (the same scan Delete is judged by); and Delete behind a confirm dialog.
//
// STATES (the same vocabulary as the item editor):
//   read-only    a caps reason (a 403 on a save, or a server-known one): every input is read-only, Save is disabled, and the
//                reason is on screen
//   saving / saved / invalid / unconfirmed (502 webdesk_ambiguous: Retry re-sends with the SAME Idempotency-Key) / unreachable
//   usage        loading / ok (an empty list is only ever said on an ok read) / error (says it is NOT the same as unused)
//   delete       confirm -> deleting -> gone | in use (the items that use it, never a bare "failed") | unconfirmed | refused
//
// The form is keyed by the asset id by the parent, so choosing another asset starts it fresh; after a save the baseline is
// the asset WebDesk answered with.

export type Cap = "upload" | "update" | "delete";

const newKey = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function MediaDetail({
  asset, scope, routeBase, locales, authors, previewBase, mode, caps, onSaved, onDeleted, onDenied, onDirty, onNotice, onUse, pickLocale, driver,
}: {
  asset: MediaAsset;
  scope: SiteScope;
  routeBase: string;
  locales: string[];
  authors: Record<string, string>;
  previewBase: string | null;
  mode: "manage" | "pick";
  /** The reason a capability is off, or null when it is on. */
  caps: { update: string | null; delete: string | null };
  onSaved: (asset: MediaAsset) => void;
  onDeleted: (assetId: string, purgeAfter: string | null) => void;
  onDenied: (cap: Cap) => void;
  onDirty: (dirty: boolean) => void;
  onNotice: (text: string) => void;
  /** Pick mode: choose this asset for the field. */
  onUse?: (asset: MediaAsset) => void;
  pickLocale?: string;
  /** WSK-49d CLIENT MODE (see `MediaLibrary`): the portal's calls; no `usage` = no "Where it's used", no `remove` = no Delete. */
  driver?: MediaDriver;
}) {
  const uid = useId();
  const [base, setBase] = useState(asset);
  const [title, setTitle] = useState(asset.title ?? "");
  const [alts, setAlts] = useState<Record<string, string>>(() => Object.fromEntries(locales.map((l) => [l, altFor(asset, l)])));
  const [tagsText, setTagsText] = useState(asset.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ tone: "bad" | "warn"; text: string } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const keyRef = useRef<{ fp: string; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const tags = useMemo(() => normalizeTags(tagsText), [tagsText]);
  const changed = useMemo(() => {
    const titleChanged = title.trim() !== (base.title ?? "");
    const tagsChanged = tags.join("\u0000") !== base.tags.join("\u0000");
    const altChanged = locales.some((l) => (alts[l] ?? "").trim() !== altFor(base, l));
    return { titleChanged, tagsChanged, altChanged, any: titleChanged || tagsChanged || altChanged };
  }, [title, tags, alts, base, locales]);
  useEffect(() => { onDirty(changed.any); }, [changed.any, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const updateReason = caps.update;
  const readOnly = updateReason !== null;

  const buildPatch = (): MediaPatch => {
    const patch: MediaPatch = {};
    if (changed.titleChanged) patch.title = title.trim() === "" ? null : title.trim();
    if (changed.altChanged) {
      // alt is the COMPLETE locale map: start from what the asset has (keeps locales this form doesn't list), then apply the edits.
      const next: Record<string, string> = { ...base.alt };
      for (const l of locales) {
        const v = (alts[l] ?? "").trim();
        if (v === "") delete next[l]; else next[l] = v;
      }
      patch.alt = next;
    }
    if (changed.tagsChanged) patch.tags = tags;
    return patch;
  };

  const save = async () => {
    if (readOnly || saving || !changed.any) return;
    const patch = buildPatch();
    const fp = JSON.stringify(patch);
    // The key is reused only to RETRY an unconfirmed save of exactly this change: WebDesk then replays its first answer.
    const key = unconfirmed && keyRef.current?.fp === fp ? keyRef.current.key : newKey();
    keyRef.current = { fp, key };
    setSaving(true); setProblem(null);
    const r = await (driver?.update ?? updateMediaAction)(scope, base.assetId, patch, key);
    if (!mounted.current) return;
    setSaving(false);
    if (r.kind === "ok") {
      const a = r.data.asset;
      setBase(a); setUnconfirmed(false); keyRef.current = null;
      setTitle(a.title ?? ""); setTagsText(a.tags.join(", "));
      setAlts(Object.fromEntries(locales.map((l) => [l, altFor(a, l)])));
      onSaved(a);
      onNotice(`Saved ${assetLabel(a)}.`);
      return;
    }
    handleFailure(r);
  };

  const handleFailure = (r: Exclude<WdResult<unknown>, { kind: "ok" }>) => {
    switch (r.kind) {
      case "forbidden":
        onDenied("update");
        setProblem({ tone: "bad", text: "You don't have permission to change this asset. Your edits are still here." });
        return;
      case "invalid":
        setProblem({ tone: "bad", text: r.issues.length ? r.issues.map((i) => i.message).join(" ") : r.message });
        return;
      case "conflict":
        setProblem({ tone: "bad", text: r.slug === "media-asset-deleted" ? "This asset was deleted in the meantime, so it can't be changed. Your edits are still here." : r.message });
        return;
      case "not_found":
        setProblem({ tone: "bad", text: "This asset no longer exists in WebDesk. Your edits are still here." });
        return;
      case "not_enabled":
        setProblem({ tone: "bad", text: "Saving isn't available on this deployment. Your edits are still here." });
        return;
      case "unavailable":
        if (isOutcomeUnknown(r)) { setUnconfirmed(true); setProblem({ tone: "warn", text: unconfirmedCopy("the save") }); return; }
        setProblem({
          tone: "bad",
          text: r.code === "contract_drift" ? `WebDesk answered unexpectedly (${r.reason}). Nothing was assumed saved. Your edits are still here.` : "Couldn't reach WebDesk. Your edits are kept here and nothing was saved.",
        });
        return;
    }
  };

  // ── where it's used ────────────────────────────────────────────────────────────────────────────
  type UsageState = { s: "loading" } | { s: "ok"; usage: MediaUsage } | { s: "error"; message: string };
  const [usage, setUsage] = useState<UsageState>({ s: "loading" });
  const showUsage = driver === undefined || driver.usage !== undefined;
  const usageCall = driver ? driver.usage : mediaUsageAction;
  const loadUsage = useCallback(async () => {
    if (!usageCall) return;
    setUsage({ s: "loading" });
    const r = await usageCall(scope, asset.assetId);
    if (!mounted.current) return;
    if (r.kind === "ok") { setUsage({ s: "ok", usage: r.data }); return; }
    setUsage({ s: "error", message: r.kind === "unavailable" ? r.reason : r.kind === "forbidden" ? "you don't have access" : r.kind === "not_found" ? "the asset no longer exists" : "not available on this deployment" });
  }, [scope, asset.assetId, usageCall]);
  useEffect(() => { void loadUsage(); }, [loadUsage]);

  // ── copy the canonical URL ─────────────────────────────────────────────────────────────────────
  const urlRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(base.url);
      onNotice("Copied the URL.");
    } catch {
      urlRef.current?.select();
      onNotice("Couldn't copy automatically. The URL is selected: copy it with your keyboard.");
    }
  };

  const [confirming, setConfirming] = useState(false);
  const preview = previewUrl(previewBase, base);
  const dims = dimensionsLabel(base);
  const itemHref = (i: MediaUsageItem) => `${routeBase}/${encodeURIComponent(i.collectionKey)}/${encodeURIComponent(i.slug)}?locale=${encodeURIComponent(i.locale)}`;

  return (
    <div className="wm-detail" data-testid="media-detail">
      <div className="wm-detail__preview">
        <MediaThumb src={preview} mime={base.mime} large />
      </div>
      <h3 className="wm-detail__title" data-testid="media-detail-title">{assetLabel(base)}</h3>

      {mode === "pick" && onUse && (
        <div className="wm-use">
          <button type="button" className="lux-btn lux-btn--solid lux-btn--md" onClick={() => onUse(base)} data-testid="media-use">Use this image</button>
          {changed.any && <span className="wc-muted">Your unsaved changes to the details are not part of what is used. Save them first.</span>}
        </div>
      )}

      {readOnly && (
        <div className="wc-banner wc-banner--info" role="note" data-testid="media-readonly"><span className="wc-banner__body"><strong>Read-only.</strong> {updateReason}</span></div>
      )}
      {problem && (
        <div className={`wc-banner wc-banner--${problem.tone}`} role="alert" data-testid="media-save-problem">
          <span className="wc-banner__body">{problem.text}</span>
          {unconfirmed && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => void save()} disabled={saving} data-testid="media-save-retry">Retry</button>}
        </div>
      )}

      <div className="wm-form">
        <div className="lux-field">
          <label className="lux-field__label" htmlFor={`${uid}-title`}>Title</label>
          <input id={`${uid}-title`} className="lux-field__control" value={title} maxLength={200} readOnly={readOnly} aria-readonly={readOnly || undefined} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <fieldset className="wm-alts">
          <legend>Alt text</legend>
          <p className="lux-field__hint">Describes the image for people who can&apos;t see it. One per language; a field uses the one for the language being edited.</p>
          {locales.map((l) => (
            <div className="lux-field" key={l}>
              <label className="lux-field__label" htmlFor={`${uid}-alt-${l}`}>Alt text ({l}){pickLocale === l ? " · this item" : ""}</label>
              <textarea
                id={`${uid}-alt-${l}`} className="lux-field__control lux-field__control--textarea" rows={2} maxLength={500}
                data-testid={`media-alt-${l}`} value={alts[l] ?? ""} readOnly={readOnly} aria-readonly={readOnly || undefined}
                onChange={(e) => setAlts((a) => ({ ...a, [l]: e.target.value }))}
              />
            </div>
          ))}
        </fieldset>

        <div className="lux-field">
          <label className="lux-field__label" htmlFor={`${uid}-tags`}>Tags</label>
          <input id={`${uid}-tags`} className="lux-field__control" value={tagsText} readOnly={readOnly} aria-readonly={readOnly || undefined} aria-describedby={`${uid}-tags-hint`} onChange={(e) => setTagsText(e.target.value)} />
          <span id={`${uid}-tags-hint`} className="lux-field__hint">Separate with commas. Saved in lower case; up to 20 tags of 40 characters.</span>
        </div>

        <div className="wc-publish__actions">
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => void save()} disabled={readOnly || saving || !changed.any} data-testid="media-save">{saving ? "Saving…" : "Save details"}</button>
          {changed.any && !saving && <span className="wc-muted" data-testid="media-dirty">Unsaved changes</span>}
        </div>
      </div>

      <dl className="wc-kv wm-facts">
        <dt>File</dt><dd>{base.originalFilename ?? "—"}</dd>
        <dt>Type</dt><dd>{mimeLabel(base.mime)}</dd>
        <dt>Size</dt><dd>{formatBytes(base.sizeBytes)}{dims ? ` · ${dims}` : ""}</dd>
        <dt>Uploaded by</dt><dd data-testid="media-uploader">{authorLabel(base.createdBy, authors)}</dd>
        <dt>Uploaded</dt><dd>{formatDateTime(base.createdAt)}</dd>
        {base.scanStatus && base.scanStatus !== "clean" && (<><dt>Scan</dt><dd>{base.scanStatus}</dd></>)}
      </dl>

      <div className="lux-field">
        <label className="lux-field__label" htmlFor={`${uid}-url`}>Canonical URL</label>
        <div className="wm-copy">
          <input id={`${uid}-url`} ref={urlRef} className="lux-field__control wc-mono" readOnly value={base.url} data-testid="media-url" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => void copy()} data-testid="media-copy">Copy URL</button>
        </div>
        <span className="lux-field__hint">This is what a media field stores. The build resolves it to the real file.</span>
      </div>

      {showUsage && (
      <section className="wm-usage" aria-labelledby={`${uid}-usage`} data-testid="media-usage">
        <h4 id={`${uid}-usage`}>Where it&apos;s used</h4>
        {usage.s === "loading" && <p className="wc-muted">Checking…</p>}
        {usage.s === "error" && (
          <div className="wc-banner wc-banner--warn" role="status" data-testid="media-usage-error">
            <span className="wc-banner__body">Couldn&apos;t check where this is used ({usage.message}). That is not the same as &ldquo;unused&rdquo;, so check before deleting.</span>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => void loadUsage()}>Try again</button>
          </div>
        )}
        {usage.s === "ok" && usage.usage.items.length === 0 && <p className="wc-publish__sub" data-testid="media-usage-none">Not used by any item.</p>}
        {usage.s === "ok" && usage.usage.items.length > 0 && (
          <>
            <ul className="wm-usage__list" data-testid="media-usage-list">
              {usage.usage.items.map((i) => (
                <li key={`${i.itemId}-${i.in}`}>
                  {mode === "pick"
                    ? <a href={itemHref(i)} target="_blank" rel="noopener noreferrer">{i.collectionKey} / {i.slug} ({i.locale})<span className="wc-sr"> (opens in a new tab)</span></a>
                    : <Link href={itemHref(i)}>{i.collectionKey} / {i.slug} ({i.locale})</Link>}{" "}
                  <span className="wc-chip">{usageLabel(i.in)}</span>
                </li>
              ))}
            </ul>
            {usage.usage.total > usage.usage.items.length && <p className="wc-muted">and {usage.usage.total - usage.usage.items.length} more not listed.</p>}
          </>
        )}
      </section>
      )}

      {(driver === undefined || driver.remove !== undefined) && (
      <div className="wm-danger">
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(true)} disabled={caps.delete !== null} aria-describedby={caps.delete ? `${uid}-del-why` : undefined} data-testid="media-delete">Delete…</button>
        {caps.delete && <span id={`${uid}-del-why`} className="wc-muted" data-testid="media-delete-why">{caps.delete}</span>}
      </div>
      )}

      <DeleteDialog
        open={confirming}
        asset={base}
        scope={scope}
        routeBase={routeBase}
        remove={driver?.remove}
        onClose={() => setConfirming(false)}
        onDenied={() => onDenied("delete")}
        onDeleted={(purgeAfter) => { setConfirming(false); onDeleted(base.assetId, purgeAfter); }}
      />
    </div>
  );
}

// ── The delete confirmation ──────────────────────────────────────────────────────────────────────

type DeleteState =
  | { s: "confirm" }
  | { s: "busy" }
  | { s: "in_use"; use: MediaInUse }
  | { s: "unconfirmed" }
  | { s: "failed"; message: string };

function DeleteDialog({
  open, asset, scope, routeBase, remove, onClose, onDenied, onDeleted,
}: {
  open: boolean; asset: MediaAsset; scope: SiteScope; routeBase: string; onClose: () => void; onDenied: () => void; onDeleted: (purgeAfter: string | null) => void;
  /** WSK-49d: the client driver's delete (it has none, so the dialog is never opened there). Absent = the staff action. */
  remove?: MediaDriver["remove"];
}) {
  const uid = useId();
  const [st, setSt] = useState<DeleteState>({ s: "confirm" });
  const keyRef = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (open) { setSt({ s: "confirm" }); keyRef.current = null; } }, [open]);

  const run = async () => {
    // Only a retry of an UNCONFIRMED delete reuses the key.
    const key = st.s === "unconfirmed" && keyRef.current ? keyRef.current : newKey();
    keyRef.current = key;
    setSt({ s: "busy" });
    const r = await (remove ?? deleteMediaAction)(scope, asset.assetId, key);
    if (!mounted.current) return;
    switch (r.kind) {
      case "ok": onDeleted(r.data.purgeAfter); return;
      case "not_found": onDeleted(null); return; // already gone: the library drops it
      case "in_use": setSt({ s: "in_use", use: r }); return;
      case "forbidden": onDenied(); setSt({ s: "failed", message: "You don't have permission to delete this asset. Deleting needs a Web Dev publisher or a company admin." }); return;
      case "unavailable":
        if (isOutcomeUnknown(r)) { setSt({ s: "unconfirmed" }); return; }
        setSt({ s: "failed", message: r.code === "contract_drift" ? `WebDesk answered unexpectedly (${r.reason}). Nothing was assumed deleted.` : "Couldn't reach WebDesk, so nothing was deleted." });
        return;
      case "conflict": setSt({ s: "failed", message: r.message }); return;
      case "invalid": setSt({ s: "failed", message: r.message }); return;
      case "not_enabled": setSt({ s: "failed", message: "Deleting isn't available on this deployment." }); return;
    }
  };

  const titleId = `${uid}-title`;
  const itemHref = (i: MediaUsageItem) => `${routeBase}/${encodeURIComponent(i.collectionKey)}/${encodeURIComponent(i.slug)}?locale=${encodeURIComponent(i.locale)}`;
  return (
    <MediaDialog open={open} onClose={() => { if (st.s !== "busy") onClose(); }} labelledBy={titleId} testId="media-delete-dialog">
      {st.s === "in_use" ? (
        <>
          <h2 id={titleId}>Can&apos;t delete: still in use</h2>
          <p data-testid="media-in-use">
            <strong>{assetLabel(asset)}</strong> is used by {st.use.total} item{st.use.total === 1 ? "" : "s"}. Replace it in each of them (or remove it), then delete it.
          </p>
          <ul className="wm-usage__list" data-testid="media-in-use-list">
            {st.use.items.map((i) => (
              <li key={`${i.itemId}-${i.in}`}>
                <a href={itemHref(i)} target="_blank" rel="noopener noreferrer">{i.collectionKey} / {i.slug} ({i.locale})<span className="wc-sr"> (opens in a new tab)</span></a>{" "}
                <span className="wc-chip">{usageLabel(i.in)}</span>
              </li>
            ))}
          </ul>
          {st.use.total > st.use.items.length && <p className="wc-muted">and {st.use.total - st.use.items.length} more not listed.</p>}
          <div className="wc-dialog__actions"><button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onClose} data-testid="media-delete-close">Close</button></div>
        </>
      ) : (
        <>
          <h2 id={titleId}>Delete this file?</h2>
          <p><strong>{assetLabel(asset)}</strong> will leave the library and stop being served. WebDesk keeps the stored file for a short retention period before removing it. A file that content still uses can&apos;t be deleted.</p>
          {st.s === "unconfirmed" && <p className="lux-field__error" role="alert" data-testid="media-delete-unconfirmed">{unconfirmedCopy("the delete")}</p>}
          {st.s === "failed" && <p className="lux-field__error" role="alert" data-testid="media-delete-failed">{st.message}</p>}
          <div className="wc-dialog__actions">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={st.s === "busy"}>Cancel</button>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => void run()} disabled={st.s === "busy"} data-testid="media-delete-confirm">
              {st.s === "busy" ? "Deleting…" : st.s === "unconfirmed" ? "Retry delete" : "Delete"}
            </button>
          </div>
        </>
      )}
    </MediaDialog>
  );
}
