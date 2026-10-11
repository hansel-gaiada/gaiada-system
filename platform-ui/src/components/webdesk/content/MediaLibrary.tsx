"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listMediaAction } from "@/lib/webdeskMediaActions";
import type { SiteScope } from "@/lib/webdeskContentActions";
import type { WdResult } from "@/lib/webdeskContentModel";
import type { MediaDriver } from "@/lib/webdeskEditorDriver";
import { formatDateTime } from "@/lib/format";
import {
  assetLabel, dimensionsLabel, formatBytes, mediaValueFor, MEDIA_TYPE_FILTERS, mimeLabel, previewUrl,
  type MediaAsset, type MediaListBody, type MediaValue,
} from "@/lib/webdeskMediaModel";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { MediaDetail, type Cap } from "./MediaDetail";
import { MediaThumb } from "./MediaThumb";
import { useMediaUploads } from "./useMediaUploads";
import "@/components/forms/forms.css";
import "./content.css";
import "./media.css";

// The media library: one component for the Media tab (`mode="manage"`) and for the picker dialog in the item editor
// (`mode="pick"`). Same grid, filters, uploads and detail panel; the one difference is that pick mode offers
// "Use this image", which hands the parent the media primitive's value for the asset.
//
// STATE MAP (the item editor's vocabulary):
//   ok + assets          the grid; "Load more" while WebDesk says there are more
//   ok + none            "empty", said ONLY on an ok read; a filtered empty says so too
//   unavailable / forbidden / not enabled / drift / not found, with nothing loaded yet
//                        the grid is NOT drawn: a notice says what happened (an empty list is a claim)
//   stale                a refresh or "load more" failed AFTER a good load: banner, the assets and the user's work are kept
//   read-only            a capability is off (a 403 on upload/update/delete, or a reason from the caller): that control is
//                        disabled and the reason is on screen; the rest of the library still works
//
// KEYBOARD. The grid is one listbox with a roving tabindex: arrows move, Home/End jump, Enter or Space selects. The upload
// control is a plain button (the drop zone is an extra, never the only way). Progress is a <progress> per file; only
// milestones are announced, politely, in a status region (never `assertive`, never `role=log`).

const PAGE_SIZE = 48;
const ASK = "Ask a Web Dev editor or a company admin for access.";
const REASONS: Record<Cap, string> = {
  upload: `You can browse the library but not add to it. ${ASK}`,
  update: `You can browse the library but not edit assets. ${ASK}`,
  delete: "Deleting needs a Web Dev publisher or a company admin.",
};

// WSK-49d CLIENT MODE: whom a client asks, and no Delete (a client has none).
const CLIENT_REASONS: Record<Cap, string> = {
  upload: "You can browse the library but not add to it. Ask your company's admin.",
  update: "You can browse the library but not edit files. Ask your company's admin.",
  delete: "Deleting files isn't available to you.",
};

type Filters = { q: string; tag: string; type: string };
const NO_FILTERS: Filters = { q: "", tag: "", type: "" };
type Problem = Exclude<WdResult<unknown>, { kind: "ok" }>;

function describe(r: Problem): string {
  switch (r.kind) {
    case "unavailable": return r.code === "contract_drift" ? `unexpected response: ${r.reason}` : r.reason;
    case "forbidden": return "you don't have access";
    case "not_enabled": return r.reason === "module_disabled" ? "the module is switched off" : "not available on this deployment yet";
    case "not_found": return "not found";
    case "conflict": case "invalid": return r.message;
  }
}

export interface MediaLibraryProps {
  mode: "manage" | "pick";
  scope: SiteScope;
  /** `/departments/:deptId/website/content/:tenant/:site`: where "Where it's used" links go. */
  routeBase: string;
  locales: string[];
  /** Pick mode: the language of the item being edited; the asset's alt for it becomes the value's alt. */
  pickLocale?: string;
  /** What the server already read. `null` makes the library load itself (the picker). */
  initial: { list: MediaListBody; loadedAt: string } | null;
  authors: Record<string, string>;
  /** Where WebDesk serves media from, for thumbnails; `null` = type tiles. */
  publicBase: string | null;
  /** Capabilities known to be off, with the reason (a future capability mirror, or a test). */
  denied?: Partial<Record<Cap, string>>;
  onPick?: (value: MediaValue, asset: MediaAsset) => void;
  /** Pick mode: the dialog's own Close. */
  onClose?: () => void;
  headingId?: string;
  /** WSK-49d CLIENT MODE: the portal's media calls. Absent = the staff actions, as before. A driver without `usage` shows no
   *  "Where it's used" and one without `remove` shows no Delete (the client BFF has neither). */
  driver?: MediaDriver;
}

export function MediaLibrary({ mode, scope, routeBase, locales, pickLocale, initial, authors, publicBase, denied, onPick, onClose, headingId, driver }: MediaLibraryProps) {
  const uid = useId();
  const [assets, setAssets] = useState<MediaAsset[]>(initial?.list.assets ?? []);
  const [page, setPage] = useState(initial?.list.page ?? null);
  const [loadedAt, setLoadedAt] = useState(initial?.loadedAt ?? null);
  const [hasData, setHasData] = useState(initial !== null);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [loading, setLoading] = useState<"idle" | "loading" | "more">(initial ? "idle" : "loading");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [off, setOff] = useState<Partial<Record<Cap, string>>>(denied ?? {});
  const [base, setBase] = useState<string | null>(publicBase);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const detailDirty = useRef(false);
  const hasDataRef = useRef(initial !== null);
  const reqId = useRef(0);
  const driverRef = useRef(driver);
  driverRef.current = driver;
  const started = useRef(false);
  const retryRef = useRef<() => void>(() => {});
  const gridRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusAfterRemove = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const clientMode = driver !== undefined;
  const deny = useCallback((cap: Cap) => setOff((o) => (o[cap] ? o : { ...o, [cap]: (clientMode ? CLIENT_REASONS : REASONS)[cap] })), [clientMode]);

  // ── reading the list ───────────────────────────────────────────────────────────────────────────
  const fetchPage = useCallback(async (filters: Filters, cursor: string | null) => {
    const my = ++reqId.current;
    setLoading(cursor ? "more" : "loading");
    const r = await (driverRef.current?.list ?? listMediaAction)(scope, { mime: filters.type || undefined, q: filters.q || undefined, tag: filters.tag || undefined, cursor: cursor ?? undefined, limit: PAGE_SIZE });
    if (!mounted.current || my !== reqId.current) return;
    setLoading("idle");
    if (r.kind !== "ok") {
      retryRef.current = () => void fetchPage(filters, cursor);
      if (!hasDataRef.current) { setProblem(r); return; }
      setStale(cursor ? `Couldn't load more (${describe(r)}).` : `Couldn't refresh (${describe(r)}).`);
      return;
    }
    setProblem(null); setStale(null); setHasData(true); hasDataRef.current = true;
    setLoadedAt(new Date().toISOString());
    setPage(r.data.page);
    setApplied(filters);
    setAssets((prev) => {
      if (!cursor) return r.data.assets;
      const seen = new Set(prev.map((a) => a.assetId));
      return [...prev, ...r.data.assets.filter((a) => !seen.has(a.assetId))];
    });
    if (!cursor) setSelectedId((cur) => (cur && r.data.assets.some((a) => a.assetId === cur) ? cur : null));
  }, [scope]);

  useEffect(() => {
    if (initial || started.current) return;
    started.current = true;
    void fetchPage(NO_FILTERS, null);
  }, [initial, fetchPage]);

  const submitFilters = (e: React.FormEvent) => {
    e.preventDefault();
    if (detailDirty.current && !window.confirm("Discard your unsaved changes to this asset?")) return;
    const next = { q: draft.q.trim(), tag: draft.tag.trim().toLowerCase(), type: draft.type };
    void fetchPage(next, null);
  };
  const clearFilters = () => { setDraft(NO_FILTERS); void fetchPage(NO_FILTERS, null); };
  const filtered = !!(applied.q || applied.tag || applied.type);

  // ── uploads ────────────────────────────────────────────────────────────────────────────────────
  const uploads = useMediaUploads({
    scope,
    mint: driver?.mintToken,
    onUploaded: (asset) => {
      setAssets((prev) => (prev.some((a) => a.assetId === asset.assetId) ? prev : [asset, ...prev]));
      setHasData(true); hasDataRef.current = true; setProblem(null);
      setSelectedId(asset.assetId); setFocusId(asset.assetId);
    },
    onDenied: () => deny("upload"),
    onOrigin: (o) => setBase((b) => b ?? o),
  });
  // Leaving the page while a file is still on its way would lose it silently (the upload belongs to this page), so ask first,
  // exactly as the item editor does for unsaved edits.
  const uploadsActive = uploads.active;
  useEffect(() => {
    if (!uploadsActive) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadsActive]);
  const uploadOff = off.upload ?? null;
  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (uploadOff) { setNotice(uploadOff); return; }
    uploads.enqueue(Array.from(list));
  };

  // ── selection and keyboard ─────────────────────────────────────────────────────────────────────
  const select = (id: string) => {
    if (id === selectedId) return;
    if (detailDirty.current && !window.confirm("Discard your unsaved changes to this asset?")) return;
    detailDirty.current = false;
    setSelectedId(id); setFocusId(id);
  };
  const tileRefs = useRef(new Map<string, HTMLElement | null>());
  const move = (from: number, to: number) => {
    const target = assets[Math.max(0, Math.min(assets.length - 1, to))];
    if (!target || to === from) return;
    setFocusId(target.assetId);
    tileRefs.current.get(target.assetId)?.focus();
  };
  const columns = (): number => {
    const first = assets[0] && tileRefs.current.get(assets[0].assetId);
    if (!first) return 1;
    const top = first.offsetTop;
    let n = 0;
    for (const a of assets) { if (tileRefs.current.get(a.assetId)?.offsetTop === top) n++; else break; }
    return Math.max(1, n);
  };
  const onGridKey = (e: React.KeyboardEvent, index: number, id: string) => {
    switch (e.key) {
      case "ArrowRight": e.preventDefault(); move(index, index + 1); break;
      case "ArrowLeft": e.preventDefault(); move(index, index - 1); break;
      case "ArrowDown": e.preventDefault(); move(index, index + columns()); break;
      case "ArrowUp": e.preventDefault(); move(index, index - columns()); break;
      case "Home": e.preventDefault(); move(index, 0); break;
      case "End": e.preventDefault(); move(index, assets.length - 1); break;
      case "Enter": case " ": e.preventDefault(); select(id); break;
    }
  };
  useEffect(() => {
    if (focusAfterRemove.current === null) return;
    const i = focusAfterRemove.current;
    focusAfterRemove.current = null;
    const target = assets[Math.min(i, assets.length - 1)];
    if (target) { setFocusId(target.assetId); tileRefs.current.get(target.assetId)?.focus(); }
    else gridRef.current?.closest("section")?.querySelector<HTMLElement>("h2, h3")?.focus();
  }, [assets]);

  const selected = assets.find((a) => a.assetId === selectedId) ?? null;
  const tabStop = focusId && assets.some((a) => a.assetId === focusId) ? focusId : (selectedId && assets.some((a) => a.assetId === selectedId) ? selectedId : assets[0]?.assetId ?? null);

  const onSaved = useCallback((a: MediaAsset) => setAssets((prev) => prev.map((x) => (x.assetId === a.assetId ? a : x))), []);
  const onDirty = useCallback((d: boolean) => { detailDirty.current = d; }, []);
  const onDeleted = useCallback((assetId: string, purgeAfter: string | null) => {
    setAssets((prev) => {
      const i = prev.findIndex((a) => a.assetId === assetId);
      focusAfterRemove.current = i < 0 ? 0 : i;
      return prev.filter((a) => a.assetId !== assetId);
    });
    detailDirty.current = false;
    setSelectedId(null);
    setNotice(purgeAfter ? `Deleted. WebDesk keeps the stored file until ${formatDateTime(purgeAfter)}, then removes it.` : "Deleted.");
  }, []);

  const heading = headingId ?? `${uid}-h`;

  // ── a read that never produced data: no grid ───────────────────────────────────────────────────
  if (!hasData && problem) {
    return <section aria-labelledby={heading} data-testid="media-library" data-mode={mode}>
      <h2 id={heading} tabIndex={-1} className="wm-heading">Media library</h2>
      <LibraryProblem result={problem} onRetry={() => retryRef.current()} />
      {mode === "pick" && onClose && <div className="wc-dialog__actions"><button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} data-testid="media-pick-close">Close</button></div>}
    </section>;
  }

  const previewFor = (a: MediaAsset) => previewUrl(base, a);

  return (
    <section className="wm-library" aria-labelledby={heading} data-testid="media-library" data-mode={mode}>
      <h2 id={heading} tabIndex={-1} className="wm-heading">{mode === "pick" ? "Choose from the media library" : "Media library"}</h2>

      {/* ── toolbar: upload + filters ─────────────────────────────────────────────────────────── */}
      <div className="wm-toolbar">
        <div className="wm-upload">
          <input
            ref={fileRef} type="file" multiple hidden data-testid="media-file-input" aria-label="Choose files to upload"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,video/mp4,video/webm"
            onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }}
          />
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => fileRef.current?.click()} disabled={uploadOff !== null} aria-describedby={uploadOff ? `${uid}-up-why` : `${uid}-up-hint`} data-testid="media-upload">Upload files</button>
          {uploadOff
            ? <span id={`${uid}-up-why`} className="wc-muted" data-testid="media-upload-why">{uploadOff}</span>
            : <span id={`${uid}-up-hint`} className="wc-muted">or drop files on the grid. Images and PDFs, and MP4 or WebM video.</span>}
        </div>
        <form className="wc-filter wm-filter" role="search" aria-label="Filter media" onSubmit={submitFilters}>
          <div className="lux-field wc-filter__q">
            <label className="lux-field__label" htmlFor={`${uid}-q`}>Search</label>
            <input id={`${uid}-q`} className="lux-field__control" value={draft.q} onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))} placeholder="Title, file name or tag" data-testid="media-q" />
          </div>
          <div className="lux-field">
            <label className="lux-field__label" htmlFor={`${uid}-tag`}>Tag</label>
            <input id={`${uid}-tag`} className="lux-field__control" value={draft.tag} onChange={(e) => setDraft((d) => ({ ...d, tag: e.target.value }))} placeholder="One tag" data-testid="media-tag" />
          </div>
          <div className="lux-field">
            <label className="lux-field__label" htmlFor={`${uid}-type`}>Type</label>
            <select id={`${uid}-type`} className="lux-field__control" value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))} data-testid="media-type">
              {MEDIA_TYPE_FILTERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={loading === "loading"}>Apply</button>
          {(filtered || draft.q || draft.tag || draft.type) && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={clearFilters}>Clear</button>}
        </form>
      </div>

      {/* ── banners ───────────────────────────────────────────────────────────────────────────── */}
      {stale !== null && (
        <div className="wc-banner wc-banner--warn" role="status" data-testid="media-stale">
          <span className="wc-banner__body"><strong>Couldn&apos;t update the list.</strong> Showing what loaded{loadedAt ? ` at ${formatDateTime(loadedAt)}` : ""}; it may be out of date.<br /><span className="wc-muted">{stale}</span></span>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => retryRef.current()} data-testid="media-stale-retry">Try again</button>
        </div>
      )}
      {base === null && assets.some((a) => a.mime.startsWith("image/")) && (
        <p className="wc-muted" data-testid="media-no-previews">Previews are off: the ERP hasn&apos;t been told where WebDesk serves media (WEBDESK_PUBLIC_BASE_URL). They appear after your first upload.</p>
      )}

      {/* ── uploads in progress / finished / refused ──────────────────────────────────────────── */}
      {uploads.rows.length > 0 && (
        <ul className="wm-uploads" aria-label="Uploads" data-testid="media-uploads">
          {uploads.rows.map((r) => (
            <li key={r.id} className={`wm-upload-row wm-upload-row--${r.state}`} data-state={r.state}>
              <span className="wm-upload-row__name">{r.file.name} <span className="wc-muted">{formatBytes(r.file.size)}</span></span>
              {r.state === "queued" && <span className="wc-muted">Waiting</span>}
              {r.state === "minting" && <span className="wc-muted">Getting permission…</span>}
              {r.state === "uploading" && (
                <>
                  <progress className="wc-progress wm-progress" max={100} value={Math.round(r.progress * 100)} aria-label={`Uploading ${r.file.name}`} />
                  <span className="wc-muted" aria-hidden="true">{Math.round(r.progress * 100)}%</span>
                </>
              )}
              {r.state === "done" && <span className="wc-chip wc-chip--ok">Uploaded</span>}
              {r.state === "failed" && r.failure && (
                <span className="wm-upload-row__fail" data-testid="media-upload-failed" data-kind={r.failure.kind}>
                  <strong>{r.failure.title}</strong>{r.failure.detail ? <> {r.failure.detail}</> : null}
                </span>
              )}
              <span className="wm-upload-row__actions">
                {r.state === "failed" && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => uploads.retry(r.id)} aria-label={`Retry ${r.file.name}`}>Retry</button>}
                {(r.state === "failed" || r.state === "done" || r.state === "queued") && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => uploads.dismiss(r.id)} aria-label={`Dismiss ${r.file.name}`}>Dismiss</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="wc-sr" role="status" aria-live="polite" data-testid="media-upload-status">{uploads.announcement}</div>
      <div className="wc-sr" role="status" aria-live="polite" data-testid="media-notice">{notice}</div>

      {/* ── the grid and the detail ───────────────────────────────────────────────────────────── */}
      <div className="wm-layout">
        <div
          className={`wm-main${dragging ? " wm-main--drop" : ""}`}
          onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = uploadOff ? "none" : "copy"; if (!dragging) setDragging(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setDragging(false); pickFiles(e.dataTransfer.files); } }}
          data-testid="media-dropzone"
        >
          {dragging && <p className="wm-drop-hint" aria-hidden="true">{uploadOff ? "Uploads are off for you" : "Drop to upload"}</p>}
          {loading === "loading" && assets.length === 0 ? (
            <p className="wc-muted" role="status" data-testid="media-loading">Loading the library…</p>
          ) : assets.length === 0 ? (
            <div data-testid="media-empty"><EmptyNote>{filtered ? "No media matches these filters." : "This site's library is empty. Upload a file to start it."}</EmptyNote></div>
          ) : (
            <div
              ref={gridRef} role="listbox" aria-label="Media" aria-describedby={`${uid}-grid-hint`} className="wm-grid" data-testid="media-grid"
              aria-busy={loading !== "idle" || undefined}
            >
              {assets.map((a, i) => {
                const label = [assetLabel(a), mimeLabel(a.mime), dimensionsLabel(a)].filter(Boolean).join(", ");
                return (
                  <div
                    key={a.assetId} role="option" aria-selected={a.assetId === selectedId} aria-label={label}
                    tabIndex={a.assetId === tabStop ? 0 : -1} className={`wm-tile${a.assetId === selectedId ? " wm-tile--on" : ""}`}
                    data-testid="media-tile" data-asset-id={a.assetId}
                    ref={(el) => { tileRefs.current.set(a.assetId, el); }}
                    onClick={() => select(a.assetId)} onKeyDown={(e) => onGridKey(e, i, a.assetId)} onFocus={() => setFocusId(a.assetId)}
                  >
                    <MediaThumb src={previewFor(a)} mime={a.mime} />
                    <span className="wm-tile__name" aria-hidden="true">{assetLabel(a)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p id={`${uid}-grid-hint`} className="wc-muted wm-grid-hint">Use the arrow keys to move between files and Enter to open one.</p>
          {page?.hasMore && page.cursor && (
            <div className="wc-pager">
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => void fetchPage(applied, page.cursor)} disabled={loading !== "idle"} data-testid="media-more">{loading === "more" ? "Loading…" : "Load more"}</button>
            </div>
          )}
          {mode === "pick" && onClose && <div className="wc-dialog__actions"><button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} data-testid="media-pick-close">Close</button></div>}
        </div>

        <aside className="wm-side" aria-label="Asset details" data-testid="media-side">
          {selected ? (
            <MediaDetail
              key={selected.assetId}
              asset={selected} scope={scope} routeBase={routeBase} locales={locales} authors={authors} previewBase={base} mode={mode} driver={driver}
              caps={{ update: off.update ?? null, delete: off.delete ?? null }}
              onSaved={onSaved} onDeleted={onDeleted} onDenied={deny} onDirty={onDirty} onNotice={setNotice}
              pickLocale={pickLocale}
              onUse={onPick ? (a) => onPick(mediaValueFor(a, pickLocale ?? locales[0] ?? ""), a) : undefined}
            />
          ) : (
            <p className="wc-muted" data-testid="media-side-empty">{mode === "pick" ? "Choose a file to see its details, then use it." : "Choose a file to see and edit its details."}</p>
          )}
        </aside>
      </div>
    </section>
  );
}

/** A read that produced no data: says what happened instead of drawing an empty library. */
function LibraryProblem({ result, onRetry }: { result: Problem; onRetry: () => void }) {
  const retry = <div className="wc-notice__actions"><button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onRetry}>Try again</button></div>;
  switch (result.kind) {
    case "unavailable":
      if (result.code === "contract_drift") {
        return (
          <div className="wc-notice wc-notice--bad" role="alert" data-testid="media-drift">
            <h3>The media API answered with something unexpected</h3>
            <p>WebDesk replied, but not in the shape the ERP expects, so nothing is shown rather than a wrong answer. This does <strong>not</strong> mean the library is empty.</p>
            <p className="wc-notice__reason">{result.reason}</p>
            {retry}
          </div>
        );
      }
      return (
        <div className="wc-notice" role="alert" data-testid="media-unavailable">
          <h3>The media library is unavailable</h3>
          <p>WebDesk can&apos;t be reached. Nothing has been lost.</p>
          <p className="wc-notice__reason">{result.reason}</p>
          {retry}
        </div>
      );
    case "forbidden":
      return (
        <div className="wc-notice" role="alert" data-testid="media-forbidden">
          <h3>You don&apos;t have access to the media library</h3>
          <p>{ASK}</p>
        </div>
      );
    case "not_enabled":
      return (
        <div className="wc-notice" role="alert" data-testid="media-not-enabled">
          <h3>{result.reason === "module_disabled" ? "The Web Dev module is switched off" : "The media library isn't served here yet"}</h3>
          <p>{result.reason === "module_disabled" ? "Nothing has been deleted." : "This deployment doesn't serve the media routes yet."}</p>
        </div>
      );
    case "not_found":
      return <div className="wc-notice" role="alert" data-testid="media-not-found"><h3>That site isn&apos;t one of your company&apos;s</h3></div>;
    case "conflict":
    case "invalid":
      return <div className="wc-notice wc-notice--bad" role="alert"><h3>The library couldn&apos;t be read</h3><p className="wc-notice__reason">{result.message}</p>{retry}</div>;
  }
}
