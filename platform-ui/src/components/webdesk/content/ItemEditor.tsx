"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createItemAndOpenAction, deleteItemAction, getItemHeadAction, refreshEditorAction, saveItemAction, type SiteScope,
} from "@/lib/webdeskContentActions";
import type { EditorBundle } from "@/lib/webdeskContent";
import {
  authorLabel, collectionLabel, deepEqual, defaultFields, isLive, isNextRedirect, isOutcomeUnknown, issuesAt, overlayNeutrals, publishStateLabel,
  SEO_CARRIER_COLLECTIONS, splitVersionContent, toWire, unconfirmedCopy, writeNeutralsThrough,
  type Block, type CollectionSummary, type EditableContent, type Issue, type ItemDetail, type ItemRef, type Lint,
  type SiteRef, type TenantRef, type WdResult,
} from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import { ConflictDialog } from "./ConflictDialog";
import { FieldEditor, type FormCtx } from "./FieldEditor";
import { PublishBar } from "./PublishBar";
import "./content.css";

// The item editor (§10: "Editor") — one component for edit AND create, because the form, the locks,
// the 422 inline errors and the dirty/saving/saved states are identical; only the write differs.
//
// STATE MAP (every row of §10's table that lives in the editor):
//   dirty / saving / saved vN   `deepEqual(draft, baseline)` + `saveState`
//   invalid (422)               `issues` -> inline errors by JSON pointer + a summary
//   conflict (409)              `conflict` -> <ConflictDialog>; the draft is untouched
//   stale                       a refresh (or a write) failed after a good load -> banner, Save/Publish disabled
//   unconfirmed (502)           a write's outcome is UNKNOWN (webdesk_ambiguous) -> "couldn't confirm" banner + Reload;
//                               never "saved", never "failed"; writes stay disabled until a re-read succeeds
//   read-only                   `readOnlyReason` (server-known) or a 403 on a write -> form disabled, reason shown
//   pending / rejected / published / rebuild   <PublishBar>
//
// LOCAL EDITS ARE NEVER THROWN AWAY by an error: not by a 409, not by a 503, not by a refresh. Only the
// user's explicit "Load theirs" replaces them.

type SaveState =
  | { s: "idle" }
  | { s: "saving" }
  | { s: "saved"; version: number; unchanged: boolean }
  | { s: "error"; message: string; issues?: Issue[] };

interface ConflictState {
  currentHeadVersion: number | null;
  updatedAt: string | null;
  savedBy: string | null;
  theirs: ItemDetail | null;
  theirsProblem: string | null;
}

export interface CreateSeed {
  locale: string;
  /** Joins this twin's localization group. */
  twinOf: string | null;
  slug: string;
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
  extraBlocks: Block[];
}

const SLUG_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REFRESH_MS = 60_000;

function describeFailure(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  switch (r.kind) {
    case "unavailable": return r.code === "contract_drift" ? `unexpected response (${r.reason})` : r.reason;
    case "forbidden": return "you don't have access";
    case "not_enabled": return "not available on this deployment";
    case "not_found": return "no longer exists";
    case "conflict": return r.message;
    case "invalid": return r.message;
  }
}

const CONFLICT_COPY: Record<string, string> = {
  "slug-taken": "That slug is already used in this collection.",
  "twin-locale-taken": "That locale already has a version of this item.",
  "singleton-exists": "This collection allows one item per locale, and it already exists.",
  "item-is-live": "The item is live — unpublish it before deleting.",
  "item-deleted": "This item has been deleted.",
  "idempotency-key-reused": "That request was already used with different content — try saving again.",
};

export function ItemEditor({
  mode, scope, routeBase, collection, tenant, site, bundle, seed, authors, readOnlyReason,
}: {
  mode: "edit" | "create";
  scope: SiteScope;
  /** `/departments/:deptId/website/content/:tenant/:site` */
  routeBase: string;
  collection: CollectionSummary;
  tenant: TenantRef;
  site: SiteRef;
  /** edit mode */
  bundle?: EditorBundle;
  /** create mode */
  seed?: CreateSeed;
  authors: Record<string, string>;
  /** Server-known reason the form is read-only (e.g. a deleted item). */
  readOnlyReason: string | null;
}) {
  const router = useRouter();
  const defs = useMemo(() => collection.composition.fields ?? [], [collection.composition.fields]);
  const seoCarrier = SEO_CARRIER_COLLECTIONS.has(collection.key);
  const localeNeutralCollection = collection.composition.localized === false;

  // ── the loaded record ──────────────────────────────────────────────────────────────────────────
  const initial = useMemo(() => {
    if (mode === "create" && seed) {
      const base: EditableContent = { fields: Object.keys(seed.fields).length ? seed.fields : defaultFields(defs), seo: seed.seo, extraBlocks: seed.extraBlocks };
      return { content: base, item: null as ItemRef | null, version: 0, lint: { unresolvedTokens: [], markers: {} } as Lint, group: [] as ItemDetail["group"], loadedAt: new Date().toISOString() };
    }
    const b = bundle as EditorBundle;
    const content = splitVersionContent(collection.key, b.detail.version.blocks, b.detail.version.seo);
    const shown = b.authoritative ? { ...content, fields: overlayNeutrals(defs, content.fields, b.authoritative.fields) } : content;
    return { content: shown, item: b.detail.item, version: b.detail.version.n, lint: b.detail.lint, group: b.detail.group, loadedAt: b.loadedAt };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [item, setItem] = useState<ItemRef | null>(initial.item);
  const [lint, setLint] = useState<Lint>(initial.lint);
  const [group, setGroup] = useState(initial.group);
  const [baseVersion, setBaseVersion] = useState(initial.version);
  const [baseline, setBaseline] = useState<{ fields: Record<string, unknown>; seo: Record<string, unknown> }>({ fields: initial.content.fields, seo: initial.content.seo });
  const [draft, setDraft] = useState<{ fields: Record<string, unknown>; seo: Record<string, unknown> }>({ fields: initial.content.fields, seo: initial.content.seo });
  const [extraBlocks, setExtraBlocks] = useState<Block[]>(initial.content.extraBlocks);
  const [authoritative, setAuthoritative] = useState(bundle?.authoritative ?? null);
  const [note, setNote] = useState("");
  const [slug, setSlug] = useState(seed?.slug ?? "");
  const [locale, setLocale] = useState(seed?.locale ?? bundle?.detail.item.locale ?? tenant.defaultLocale);
  const [loadedAt, setLoadedAt] = useState(initial.loadedAt);
  const [build, setBuild] = useState(bundle?.build ?? null);

  const [saveState, setSaveState] = useState<SaveState>({ s: "idle" });
  const [issues, setIssues] = useState<Issue[]>([]);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  /** The words for a write whose outcome is unknown (502 webdesk_ambiguous); null when nothing is in doubt. */
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [headSeen, setHeadSeen] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ tone: "warn" | "bad" | "info"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const dirty = useMemo(() => !deepEqual(draft, baseline), [draft, baseline]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const nonDefaultLocale = locale !== tenant.defaultLocale && !localeNeutralCollection;
  const readOnlyWhy = readOnlyReason ?? (forbidden ? "You can read this item but not change it. Ask a Web Dev editor or publisher for access." : null);
  const readOnly = readOnlyWhy !== null;
  const canWrite = !readOnly && stale === null && unconfirmed === null;

  const ctx: FormCtx = {
    issues, readOnly, neutralLock: nonDefaultLocale, neutralLocale: tenant.defaultLocale,
  };

  // ── adopting a freshly read record (initial refresh, Load theirs, restore) ─────────────────────
  const adopt = useCallback((detail: ItemDetail, auth: EditorBundle["authoritative"]) => {
    const content = splitVersionContent(collection.key, detail.version.blocks, detail.version.seo);
    const shown = auth ? overlayNeutrals(defs, content.fields, auth.fields) : content.fields;
    setItem(detail.item); setLint(detail.lint); setGroup(detail.group);
    setBaseVersion(detail.version.n);
    setBaseline({ fields: shown, seo: content.seo });
    setDraft({ fields: shown, seo: content.seo });
    setExtraBlocks(content.extraBlocks);
    setAuthoritative(auth);
    setIssues([]); setHeadSeen(null);
  }, [collection.key, defs]);

  // ── refresh: the one thing that can flip the page to STALE ─────────────────────────────────────
  const refresh = useCallback(async () => {
    if (mode !== "edit" || !item) return;
    setRefreshing(true);
    const r = await refreshEditorAction(scope, collection.key, item.slug, item.locale);
    if (!mounted.current) return;
    setRefreshing(false);
    if (r.kind !== "ok") {
      setStale(r.kind === "unavailable" && r.code === "contract_drift" ? `unexpected response — ${r.reason}` : describeFailure(r));
      return;
    }
    setStale(null);
    setUnconfirmed(null); // a good re-read is the "reload" the unknown-outcome notice asks for
    setLoadedAt(r.data.loadedAt);
    setBuild(r.data.build);
    if (!dirtyRef.current) adopt(r.data.detail, r.data.authoritative);
    else {
      // Keep the draft; just say the head moved.
      setItem(r.data.detail.item); setLint(r.data.detail.lint); setGroup(r.data.detail.group);
      setHeadSeen(r.data.detail.version.n);
    }
  }, [mode, item, scope, collection.key, adopt]);

  useEffect(() => {
    if (mode !== "edit") return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [mode, refresh]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const goStale = useCallback((reason: string) => setStale(reason), []);

  // ── save ───────────────────────────────────────────────────────────────────────────────────────
  const buildFields = () => {
    const f = nonDefaultLocale ? writeNeutralsThrough(defs, draft.fields, authoritative?.fields ?? null) : draft.fields;
    return toWire(f);
  };

  const handleWriteFailure = (r: Exclude<WdResult<unknown>, { kind: "ok" }>, verb: string) => {
    switch (r.kind) {
      case "invalid":
        setIssues(r.issues);
        setSaveState({ s: "error", message: r.issues.length ? `${r.issues.length} problem${r.issues.length === 1 ? "" : "s"} to fix before it can be ${verb}.` : r.message, issues: r.issues });
        requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-pointer][aria-invalid='true']")?.scrollIntoView?.({ block: "center" }));
        return;
      case "forbidden":
        setForbidden(true);
        setSaveState({ s: "error", message: "You don't have permission to change this item. Your edits are still here." });
        return;
      case "unavailable":
        if (isOutcomeUnknown(r)) {
          // Unknown, not failed: the write may have landed. Edits are kept; writes stay off until a re-read.
          setUnconfirmed(unconfirmedCopy(verb === "created" ? "the new item" : "the save"));
          setSaveState({ s: "idle" });
          return;
        }
        if (r.code !== "contract_drift") goStale(r.reason);
        setSaveState({ s: "error", message: r.code === "contract_drift" ? `WebDesk answered unexpectedly (${r.reason}). Nothing was assumed saved — your edits are still here.` : "Couldn't reach WebDesk. Your edits are kept here and nothing was saved." });
        return;
      case "not_found":
        setSaveState({ s: "error", message: "This item no longer exists in WebDesk. Your edits are still here." });
        return;
      case "not_enabled":
        setSaveState({ s: "error", message: "Saving isn't available on this deployment. Your edits are still here." });
        return;
      case "conflict":
        setSaveState({ s: "error", message: CONFLICT_COPY[r.slug] ?? r.message });
        if (r.slug === "slug-taken") setIssues([{ path: "/slug", message: CONFLICT_COPY["slug-taken"] }]);
        return;
    }
  };

  const save = async (baseOverride?: number) => {
    if (!canWrite) return;
    setSaveState({ s: "saving" }); setBanner(null);
    const sentFields = buildFields();
    const sentSeo = toWire(draft.seo);

    if (mode === "create") {
      if (!SLUG_RE.test(slug) || slug.length > 200) {
        setIssues([{ path: "/slug", message: "Use lowercase letters, digits, dots and hyphens (for example service.seo)." }]);
        setSaveState({ s: "error", message: "The slug isn't valid." });
        return;
      }
      // Success opens the new item from the SERVER (`createItemAndOpenAction` redirects; see webdeskContentActions.ts):
      // a client push here was sometimes dropped by the router. Only a failure comes back, typed as before.
      let r: Awaited<ReturnType<typeof createItemAndOpenAction>>;
      try {
        r = await createItemAndOpenAction(scope, { collectionKey: collection.key, locale, slug, twinOf: seed?.twinOf ?? null, fields: sentFields, blocks: extraBlocks, seo: sentSeo, note }, routeBase);
      } catch (e) {
        if (isNextRedirect(e)) return; // created, and already on its editor
        throw e;
      }
      if (!mounted.current) return;
      handleWriteFailure(r, "created");
      return;
    }

    if (!item) return;
    const r = await saveItemAction(scope, item.itemId, { baseVersion: baseOverride ?? baseVersion, fields: sentFields, blocks: extraBlocks, seo: sentSeo, note });
    if (!mounted.current) return;
    if (r.kind === "ok") {
      setItem(r.data.item); setLint(r.data.lint); setBaseVersion(r.data.version.version);
      setBaseline({ fields: draft.fields, seo: draft.seo });
      setIssues([]); setHeadSeen(null); setConflict(null); setNote("");
      setSaveState({ s: "saved", version: r.data.version.version, unchanged: r.data.unchanged });
      return;
    }
    if (r.kind === "conflict" && r.slug === "version-conflict") {
      await openConflict(r);
      return;
    }
    handleWriteFailure(r, "saved");
  };

  const openConflict = async (r: Extract<WdResult<unknown>, { kind: "conflict" }>) => {
    setSaveState({ s: "idle" });
    const theirs = item ? await getItemHeadAction(scope, item.itemId) : null;
    if (!mounted.current) return;
    const head = theirs && theirs.kind === "ok" ? theirs.data : null;
    setConflict({
      currentHeadVersion: r.currentHeadVersion ?? head?.version.n ?? null,
      updatedAt: r.updatedAt ?? head?.version.createdAt ?? null,
      savedBy: head ? authorLabel(head.version.createdBy, authors) : null,
      theirs: head,
      theirsProblem: head ? null : theirs ? describeFailure(theirs as Exclude<WdResult<unknown>, { kind: "ok" }>) : "no item loaded",
    });
  };

  const saveMineOnTop = async () => {
    if (!conflict || conflict.currentHeadVersion === null) return;
    setConflictBusy(true);
    await save(conflict.currentHeadVersion);
    if (mounted.current) setConflictBusy(false);
  };

  const loadTheirs = () => {
    if (!conflict?.theirs) return;
    adopt(conflict.theirs, authoritative);
    setConflict(null);
    setSaveState({ s: "idle" });
    setBanner({ tone: "info", text: `Loaded v${conflict.theirs.version.n}. Your previous edits were discarded.` });
  };

  // ── locale twin ────────────────────────────────────────────────────────────────────────────────
  const createTwin = async (target: string) => {
    if (!item) return;
    if (dirty && !window.confirm("You have unsaved changes. Create the twin from the last saved version?")) return;
    setBanner(null);
    // Success opens the twin from the SERVER (see `save` above); only a failure comes back.
    let r: Awaited<ReturnType<typeof createItemAndOpenAction>>;
    try {
      r = await createItemAndOpenAction(scope, {
        collectionKey: collection.key, locale: target, slug: item.slug, twinOf: item.itemId,
        fields: toWire(baseline.fields), blocks: extraBlocks, seo: toWire(baseline.seo),
      }, routeBase);
    } catch (e) {
      if (isNextRedirect(e)) return; // created, and already on the twin's editor
      throw e;
    }
    if (!mounted.current) return;
    if (r.kind === "invalid") {
      setBanner({ tone: "bad", text: `The ${target} twin couldn't be created: ${r.issues.map((i) => i.message).slice(0, 3).join("; ") || r.message}` });
    } else if (r.kind === "conflict") {
      setBanner({ tone: "bad", text: CONFLICT_COPY[r.slug] ?? r.message });
    } else if (isOutcomeUnknown(r)) {
      setUnconfirmed(unconfirmedCopy(`the ${target} twin`));
    } else {
      setBanner({ tone: "bad", text: `The ${target} twin couldn't be created (${describeFailure(r)}).` });
    }
  };

  const doDelete = async () => {
    if (!item) return;
    setConfirmDelete(false);
    const r = await deleteItemAction(scope, item.itemId, baseVersion);
    if (!mounted.current) return;
    if (r.kind === "ok") {
      setBaseline(draft);
      router.push(`${routeBase}/${encodeURIComponent(collection.key)}`);
      return;
    }
    if (isOutcomeUnknown(r)) { setUnconfirmed(unconfirmedCopy("the delete")); return; }
    if (r.kind === "unavailable" && r.code !== "contract_drift") goStale(r.reason);
    setBanner({ tone: "bad", text: r.kind === "conflict" ? (CONFLICT_COPY[r.slug] ?? r.message) : `Couldn't delete (${describeFailure(r)}).` });
  };

  // ── render ─────────────────────────────────────────────────────────────────────────────────────
  const stagingBase = site.environments.find((e) => e.name.toLowerCase() === "staging" && e.domain);
  const urlField = typeof (nonDefaultLocale ? draft.fields.url : baseline.fields.url) === "string" ? (baseline.fields.url as string) : null;
  const stagingItemUrl = stagingBase && urlField && urlField.startsWith("/") && item && isLive(item) ? `https://${stagingBase.domain}${urlField}` : null;

  const titleField = collection.composition.ui?.titleField;
  const title = (titleField && typeof draft.fields[titleField] === "string" && (draft.fields[titleField] as string)) || (typeof draft.seo.title === "string" && draft.seo.title) || (mode === "edit" ? item?.slug : "New item");
  const dirtyNote = dirty ? "Unsaved changes" : saveState.s === "saved" ? (saveState.unchanged ? `No changes — still v${saveState.version}` : `Saved v${saveState.version}`) : "No changes";

  const switchLocale = (e: React.MouseEvent) => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) e.preventDefault();
  };

  const seoTitleIssues = issuesAt(issues, "/seo/title");
  const seoDescIssues = issuesAt(issues, "/seo/description");
  const slugIssues = issuesAt(issues, "/slug");

  return (
    <div className="wc-editor" data-testid="item-editor" data-mode={mode}>
      <div className="wc-editor__main">
        <div>
          <p className="wc-muted">{collectionLabel(collection)} · {site.name}</p>
          <h2 style={{ margin: "2px 0 0", font: "700 22px var(--font-display)", color: "var(--ink-strong)" }} data-testid="editor-title">{title}</h2>
        </div>

        {/* Locale tabs with twin status (§10) */}
        {!localeNeutralCollection && tenant.locales.length > 1 && (
          <nav className="wc-locales" aria-label="Locales" data-testid="locale-tabs">
            {tenant.locales.map((l) => {
              const member = group.find((g) => g.locale === l);
              const isThis = l === locale;
              if (mode === "create") {
                return <span key={l} className="wc-locale" aria-current={isThis ? "page" : undefined}>{l}{isThis ? " · new" : ""}</span>;
              }
              if (isThis) return <span key={l} className="wc-locale" aria-current="page">{l} · {item ? publishStateLabel(item.publishState) : ""}</span>;
              if (member) {
                return (
                  <Link key={l} href={`${routeBase}/${encodeURIComponent(collection.key)}/${encodeURIComponent(member.slug)}?locale=${encodeURIComponent(l)}`} className="wc-locale" onClick={switchLocale} data-testid={`locale-${l}`}>
                    {l} · {publishStateLabel(member.publishState)}
                  </Link>
                );
              }
              return (
                <button key={l} type="button" className="wc-locale wc-locale--missing" data-testid={`create-locale-${l}`} onClick={() => createTwin(l)} disabled={!canWrite}>
                  {l} · not created — Create
                </button>
              );
            })}
          </nav>
        )}
        {localeNeutralCollection && <p className="wc-muted">This collection is locale-neutral: one item, in {tenant.defaultLocale}.</p>}

        {/* ── banners ───────────────────────────────────────────────────────────────────────── */}
        {stale !== null && (
          <div className="wc-banner wc-banner--warn" role="status" data-testid="stale-banner">
            <span className="wc-banner__body"><strong>Couldn&apos;t refresh</strong> — showing what loaded at {formatDateTime(loadedAt)}. Save and publish are disabled until WebDesk answers again.<br /><span className="wc-muted">{stale}</span></span>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={refresh} disabled={refreshing} data-testid="refresh">{refreshing ? "Refreshing…" : "Try again"}</button>
          </div>
        )}
        {unconfirmed !== null && (
          <div className="wc-banner wc-banner--warn" role="alert" data-testid="unconfirmed-banner">
            <span className="wc-banner__body"><strong>{unconfirmed}</strong>{mode === "edit" ? " Your edits are still here." : ""}</span>
            {mode === "edit" && (
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={refresh} disabled={refreshing} data-testid="unconfirmed-reload">{refreshing ? "Reloading…" : "Reload"}</button>
            )}
          </div>
        )}
        {readOnlyWhy && (
          <div className="wc-banner wc-banner--info" role="note" data-testid="readonly-banner">
            <span className="wc-banner__body"><strong>Read-only.</strong> {readOnlyWhy}</span>
          </div>
        )}
        {headSeen !== null && headSeen > baseVersion && !conflict && (
          <div className="wc-banner wc-banner--warn" data-testid="behind-head">
            <span className="wc-banner__body">v{headSeen} was saved since you opened this (you are on v{baseVersion}). Saving will ask you how to combine them; your edits are kept.</span>
          </div>
        )}
        {banner && <div className={`wc-banner wc-banner--${banner.tone}`} role={banner.tone === "bad" ? "alert" : "status"} data-testid="editor-banner"><span className="wc-banner__body">{banner.text}</span></div>}
        {authoritativeNote(bundle)}
        {saveState.s === "error" && (
          <div className="wc-banner wc-banner--bad" role="alert" data-testid="save-error"><span className="wc-banner__body">{saveState.message}
              {/* Every issue, with its pointer: one with no control on this form (an unknown key, a member the
                  composition hides) must still be visible somewhere, never silently counted. */}
              {saveState.issues && saveState.issues.length > 0 && (
                <ul className="wc-errors" data-testid="issue-list">{saveState.issues.map((i, n) => <li key={n}><code>{i.path || "/"}</code> — {i.message}</li>)}</ul>
              )}
            </span></div>
        )}

        {/* ── create-only: slug ─────────────────────────────────────────────────────────────── */}
        {mode === "create" && (
          <div className="lux-field wc-field">
            <label className="lux-field__label lux-field__label--req" htmlFor="wc-slug">Slug</label>
            <input id="wc-slug" className={`lux-field__control${slugIssues.length ? " lux-field__control--error" : ""}`} value={slug} onChange={(e) => setSlug(e.target.value)} aria-invalid={slugIssues.length > 0 || undefined} aria-describedby="wc-slug-hint" data-pointer="/slug" autoComplete="off" spellCheck={false} />
            <span id="wc-slug-hint" className="lux-field__hint">The item&apos;s stable id, shared by its locale twins and unchangeable after creation (for example <code>service.seo</code>).</span>
            {slugIssues.map((i, n) => <span key={n} className="lux-field__error">{i.message}</span>)}
          </div>
        )}

        {/* ── the form ──────────────────────────────────────────────────────────────────────── */}
        {defs.length > 0 ? (
          <FieldEditor defs={defs} value={draft.fields} onChange={(fields) => setDraft((d) => ({ ...d, fields }))} ctx={ctx} />
        ) : (
          <p className="lux-field__hint">This collection declares no fields.</p>
        )}

        {!seoCarrier && (
          <fieldset className="wc-group" data-pointer="/seo">
            <legend>Search appearance</legend>
            <p className="lux-field__hint">The page&apos;s title and description (<code>seo.title</code> / <code>seo.description</code>) — there are no separate copies in the fields above.</p>
            <div className="lux-field wc-field">
              <label className="lux-field__label" htmlFor="wc-seo-title">SEO title</label>
              <input id="wc-seo-title" className={`lux-field__control${seoTitleIssues.length ? " lux-field__control--error" : ""}`} data-pointer="/seo/title" value={typeof draft.seo.title === "string" ? draft.seo.title : ""} readOnly={readOnly} aria-readonly={readOnly || undefined} aria-invalid={seoTitleIssues.length > 0 || undefined} onChange={(e) => setDraft((d) => ({ ...d, seo: setOrDrop(d.seo, "title", e.target.value) }))} />
              {seoTitleIssues.map((i, n) => <span key={n} className="lux-field__error">{i.message}</span>)}
            </div>
            <div className="lux-field wc-field">
              <label className="lux-field__label" htmlFor="wc-seo-desc">SEO description</label>
              <textarea id="wc-seo-desc" className={`lux-field__control lux-field__control--textarea${seoDescIssues.length ? " lux-field__control--error" : ""}`} data-pointer="/seo/description" rows={3} value={typeof draft.seo.description === "string" ? draft.seo.description : ""} readOnly={readOnly} aria-readonly={readOnly || undefined} aria-invalid={seoDescIssues.length > 0 || undefined} onChange={(e) => setDraft((d) => ({ ...d, seo: setOrDrop(d.seo, "description", e.target.value) }))} />
              {seoDescIssues.map((i, n) => <span key={n} className="lux-field__error">{i.message}</span>)}
            </div>
          </fieldset>
        )}

        {extraBlocks.length > 0 && (
          <p className="lux-field__hint">{extraBlocks.length} vocabulary block{extraBlocks.length === 1 ? "" : "s"} after the fields are kept as they are — they can&apos;t be edited in this form.</p>
        )}

        {/* ── save bar ──────────────────────────────────────────────────────────────────────── */}
        <div className="wc-savebar" data-testid="savebar">
          <span className="wc-savebar__status" role="status" data-testid="save-status" data-dirty={dirty || undefined}>
            {saveState.s === "saving" ? "Saving…" : dirtyNote}
          </span>
          {!readOnly && (
            <div className="lux-field wc-savebar__note">
              <label className="wc-sr" htmlFor="wc-note">Change note (optional)</label>
              <input id="wc-note" className="lux-field__control" placeholder="Change note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          <button
            type="button" className="lux-btn lux-btn--solid lux-btn--md" data-testid="save"
            onClick={() => void save()}
            disabled={!canWrite || saveState.s === "saving" || (mode === "edit" && !dirty)}
            aria-describedby={!canWrite ? "wc-save-why" : undefined}
          >
            {mode === "create" ? "Create" : "Save"}
          </button>
          {!canWrite && <span id="wc-save-why" className="wc-muted">{readOnly ? "Read-only" : unconfirmed !== null && stale === null ? "Disabled until you reload" : "Disabled until WebDesk answers again"}</span>}
        </div>
      </div>

      {/* ── side panel ──────────────────────────────────────────────────────────────────────── */}
      <aside className="wc-editor__side" aria-label="Item details">
        {mode === "edit" && item && (
          <>
            <section className="wc-side-card">
              <h3>Status</h3>
              <dl className="wc-kv">
                <dt>State</dt><dd data-testid="item-state">{item.deletedAt ? "Deleted" : publishStateLabel(item.publishState)}</dd>
                <dt>Head</dt><dd data-testid="item-head">v{item.headVersion}</dd>
                <dt>Live</dt><dd>{item.publishedVersion !== null ? `v${item.publishedVersion}` : "—"}</dd>
                <dt>Updated</dt><dd>{formatDateTime(item.updatedAt)}</dd>
                <dt>Loaded</dt><dd data-testid="loaded-at">{formatDateTime(loadedAt)}</dd>
              </dl>
              <div className="wc-publish__actions">
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={refresh} disabled={refreshing} data-testid="refresh-now">{refreshing ? "Refreshing…" : "Refresh"}</button>
                <Link className="lux-btn lux-btn--ghost lux-btn--sm" href={`${routeBase}/${encodeURIComponent(collection.key)}/${encodeURIComponent(item.slug)}/history?locale=${encodeURIComponent(item.locale)}`}>Version history</Link>
              </div>
            </section>

            <PublishBar
              scope={scope}
              item={item}
              version={baseVersion}
              dirty={dirty}
              blocked={readOnly ? "Read-only." : stale !== null ? "Disabled until WebDesk answers again." : unconfirmed !== null ? "Disabled until you reload." : null}
              initialPending={bundle?.pendingRequests ?? null}
              pendingProblem={bundle?.pendingProblem ?? null}
              initialBuild={build}
              buildProblem={bundle?.buildProblem ?? null}
              stagingUrl={stagingItemUrl}
              onItemChanged={(it) => { setItem(it); }}
              onUnavailable={goStale}
              onUnconfirmed={(what) => setUnconfirmed(unconfirmedCopy(what))}
            />

            <section className="wc-side-card" data-testid="lint-card">
              <h3>Placeholders</h3>
              {lint.unavailable !== undefined ? (
                // The lint could not RUN. Its empty lists are not a finding, so this is never the all-clear.
                <p className="wc-publish__sub" role="note" data-testid="lint-unavailable">
                  Couldn&apos;t check for placeholders. This is not a statement that there are none.
                </p>
              ) : lint.unresolvedTokens.length === 0 && Object.values(lint.markers).every((n) => n === 0) ? (
                <p className="wc-publish__sub">No unresolved placeholders.</p>
              ) : (
                <>
                  <p className="wc-publish__sub">Advisory only — these never block saving or publishing.</p>
                  {Object.entries(lint.markers).filter(([, n]) => n > 0).map(([label, n]) => <p key={label} className="wc-publish__sub" data-testid={`marker-${label}`}>{n} × [{label}: …]</p>)}
                  {lint.unresolvedTokens.length > 0 && (
                    <ul className="wc-lint" data-testid="unresolved-tokens">{lint.unresolvedTokens.map((t) => <li key={t}>{t}</li>)}</ul>
                  )}
                </>
              )}
            </section>

            {stagingItemUrl && (
              <section className="wc-side-card"><h3>Staging</h3><a href={stagingItemUrl} target="_blank" rel="noopener noreferrer" data-testid="view-staging">View on staging</a></section>
            )}

            {!isLive(item) && !item.deletedAt && !readOnly && (
              <section className="wc-side-card">
                <h3>Delete</h3>
                {!confirmDelete ? (
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmDelete(true)} disabled={!canWrite}>Delete draft…</button>
                ) : (
                  <>
                    <p className="wc-publish__sub">Delete this draft? History is kept and an operator can reverse it.</p>
                    <div className="wc-publish__actions">
                      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={doDelete}>Delete</button>
                      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}
        {mode === "create" && (
          <section className="wc-side-card">
            <h3>New item</h3>
            <p className="wc-publish__sub">A new item starts as a draft. Publishing is requested after it is created.</p>
          </section>
        )}
      </aside>

      <ConflictDialog
        open={conflict !== null}
        headVersion={conflict?.currentHeadVersion ?? null}
        savedBy={conflict?.savedBy ?? null}
        savedAt={conflict?.updatedAt ?? null}
        mineBase={baseVersion}
        canSaveOnTop={conflict?.currentHeadVersion !== null && conflict?.currentHeadVersion !== undefined}
        theirsProblem={conflict?.theirsProblem ?? null}
        busy={conflictBusy}
        onSaveMine={() => void saveMineOnTop()}
        onLoadTheirs={loadTheirs}
        onKeepEditing={() => setConflict(null)}
      />
    </div>
  );
}

function setOrDrop(o: Record<string, unknown>, k: string, v: string): Record<string, unknown> {
  const n = { ...o };
  if (v === "") delete n[k]; else n[k] = v;
  return n;
}

function authoritativeNote(bundle: EditorBundle | undefined) {
  if (!bundle?.authoritativeProblem) return null;
  return (
    <div className="wc-banner wc-banner--warn" role="note" data-testid="authoritative-problem">
      <span className="wc-banner__body">{bundle.authoritativeProblem}</span>
    </div>
  );
}
