"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createItemAndOpenAction, deleteItemAction, getItemHeadAction, previewItemAction, refreshEditorAction, saveItemAction, type SiteScope,
} from "@/lib/webdeskContentActions";
import type { EditorBundle } from "@/lib/webdeskContent";
import type { ClientModeCfg, EditorDriver } from "@/lib/webdeskEditorDriver";
import { CLIENT_COPY, clientRefusal, plainForClient } from "@/lib/webdeskClientCopy";
import { clientFieldsToSend } from "@/lib/webdeskClientFields";
import {
  authorLabel, collectionLabel, deepEqual, defaultFields, isLive, isNextRedirect, isOutcomeUnknown, issuesAt, overlayNeutrals, publishStateLabel,
  SEO_CARRIER_COLLECTIONS, splitVersionContent, toWire, unconfirmedCopy, writeNeutralsThrough,
  type Block, type CollectionSummary, type EditableContent, type Issue, type ItemDetail, type ItemRef, type Lint,
  type SiteRef, type TenantRef, type WdResult,
} from "@/lib/webdeskContentModel";
import { formatDateTime } from "@/lib/format";
import { ConflictDialog } from "./ConflictDialog";
import { placeholderSyntaxes } from "@/lib/markdownCodec";
import { FieldEditor, type FormCtx } from "./FieldEditor";
import { ContentChecksCard } from "./ContentChecksCard";
import { PreviewCard } from "./PreviewCard";
import { PublishBar } from "./PublishBar";
import { EditorialPanel } from "../editorial/EditorialPanel";
import { AssistDrawer } from "./AssistDrawer";
import type { EditorialInitial } from "@/lib/webdeskEditorialModel";
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

/** The staff editor's own server calls, bound to the actions it has always used. Lambdas, so a call resolves the action when it
 *  RUNS (the editor's tests replace those modules). A client editor passes its own `EditorDriver` through `clientMode`. */
const staffApi: EditorDriver = {
  refreshEditor: (...a) => refreshEditorAction(...a),
  getItemHead: (...a) => getItemHeadAction(...a),
  saveItem: (scope, itemId, input) => saveItemAction(scope, itemId, input as Parameters<typeof saveItemAction>[2]),
  createAndOpen: (scope, input, routeBase) => createItemAndOpenAction(scope, input as Parameters<typeof createItemAndOpenAction>[1], routeBase),
  previewItem: (...a) => previewItemAction(...a),
};

export function ItemEditor({
  mode, scope, routeBase, collection, tenant, site, bundle, seed, authors, readOnlyReason, mediaPublicBase = null, clientMode, editorial,
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
  /** WSK-43c: where WebDesk serves media from (thumbnails in the picker); null = type tiles. */
  mediaPublicBase?: string | null;
  /** WSK-49d: CLIENT MODE (the client portal's Website area). Absent = the staff editor, exactly as before. Present: the server calls
   *  are the portal's (`driver`), a field the BFF says is not client-editable renders read-only ("Managed by Gaiada."), `seo` is shown
   *  read-only, a save sends `{ baseVersion, fields, note }` only, a 409 is a Reload banner, and there is no delete, unpublish,
   *  schedule, twin creation, key or schema UI. The staff editor never passes it. */
  clientMode?: ClientModeCfg;
  /** M5-W2e: the writers' room review panel (staff editor only). The item page passes what it read: the item's `editorial` + `allowed`
   *  and its review record. Absent = no panel (create mode, the client portal, tests that predate it). */
  editorial?: EditorialInitial;
}) {
  const router = useRouter();
  const api: EditorDriver = clientMode?.driver ?? staffApi;
  /** Client-mode wording for a sentence written for staff. Identity for the staff editor. */
  const say = (text: string): string => (clientMode ? plainForClient(text) : text);
  const defs = useMemo(() => collection.composition.fields ?? [], [collection.composition.fields]);
  const seoCarrier = SEO_CARRIER_COLLECTIONS.has(collection.key);
  const localeNeutralCollection = collection.composition.localized === false;

  // ── the loaded record ──────────────────────────────────────────────────────────────────────────
  const initial = useMemo(() => {
    if (mode === "create" && seed) {
      const base: EditableContent = { fields: Object.keys(seed.fields).length ? seed.fields : defaultFields(defs), seo: seed.seo, extraBlocks: seed.extraBlocks };
      return { content: base, stored: {} as Record<string, unknown>, item: null as ItemRef | null, version: 0, lint: { unresolvedTokens: [], markers: {} } as Lint, group: [] as ItemDetail["group"], loadedAt: new Date().toISOString() };
    }
    const b = bundle as EditorBundle;
    const content = splitVersionContent(collection.key, b.detail.version.blocks, b.detail.version.seo);
    const shown = b.authoritative ? { ...content, fields: overlayNeutrals(defs, content.fields, b.authoritative.fields) } : content;
    return { content: shown, stored: content.fields, item: b.detail.item, version: b.detail.version.n, lint: b.detail.lint, group: b.detail.group, loadedAt: b.loadedAt };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [item, setItem] = useState<ItemRef | null>(initial.item);
  const [lint, setLint] = useState<Lint>(initial.lint);
  const [group, setGroup] = useState(initial.group);
  const [baseVersion, setBaseVersion] = useState(initial.version);
  /** The item's OWN stored fields: what the head holds, BEFORE `overlayNeutrals` shows a non-default locale the default locale's shared values.
   *  Client mode builds its wire body from these (never from the overlaid display), so a protected shared field goes back as stored. */
  const [stored, setStored] = useState<Record<string, unknown>>(initial.stored);
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
  /** Client mode: the head moved after this page loaded (409 version-conflict). The draft is untouched; the banner offers Reload. */
  const [clientConflict, setClientConflict] = useState(false);
  /** Who wrote the version this editor is on (the saved head the draft is based on); drives "Publish now" in client mode. */
  const [headAuthor, setHeadAuthor] = useState<string | null>(bundle?.detail.version.createdBy ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const dirty = useMemo(() => !deepEqual(draft, baseline), [draft, baseline]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const nonDefaultLocale = locale !== tenant.defaultLocale && !localeNeutralCollection;
  const readOnlyWhy = readOnlyReason ?? (forbidden ? (clientMode ? CLIENT_COPY.noEditAccess : "You can read this item but not change it. Ask a Web Dev editor or publisher for access.") : null);
  const readOnly = readOnlyWhy !== null;
  const canWrite = !readOnly && stale === null && unconfirmed === null && !clientConflict;

  const placeholders = useMemo(() => placeholderSyntaxes(collection.composition.lint?.placeholders), [collection.composition.lint]);
  // The "Choose from library" button of a media field: it needs the site, the language being edited (the asset's alt for it
  // becomes the value's alt) and who the uploaders are. Picking only fills the field; saving the item is still this editor's.
  const ctx: FormCtx = {
    issues, readOnly, neutralLock: nonDefaultLocale, neutralLocale: tenant.defaultLocale, placeholders,
    media: { scope, routeBase, locale, locales: tenant.locales, authors, publicBase: mediaPublicBase, driver: clientMode?.mediaDriver },
    clientEditable: clientMode?.editable.fields,
  };

  // ── adopting a freshly read record (initial refresh, Load theirs, restore) ─────────────────────
  const adopt = useCallback((detail: ItemDetail, auth: EditorBundle["authoritative"]) => {
    const content = splitVersionContent(collection.key, detail.version.blocks, detail.version.seo);
    const shown = auth ? overlayNeutrals(defs, content.fields, auth.fields) : content.fields;
    setItem(detail.item); setLint(detail.lint); setGroup(detail.group);
    setBaseVersion(detail.version.n);
    setHeadAuthor(detail.version.createdBy);
    setStored(content.fields);
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
    const r = await api.refreshEditor(scope, collection.key, item.slug, item.locale);
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
  }, [mode, item, scope, collection.key, adopt, api]);

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
    // CLIENT MODE: every refusal a client can meet is a plain sentence (`lib/webdeskClientCopy.ts`). A 422 about the CONTENT
    // (no §16j slug: a composition violation) still falls through to the inline, per-field errors below.
    if (clientMode && !(r.kind === "invalid" && !r.slug)) {
      const f = clientRefusal(r, verb === "created" ? "create" : "save", { defs });
      if (f.unknown) { setUnconfirmed(unconfirmedCopy(verb === "created" ? "the new page" : "the save")); setSaveState({ s: "idle" }); return; }
      if (r.kind === "forbidden" && !r.slug) setForbidden(true);
      if (r.kind === "unavailable" && r.code !== "contract_drift") goStale(r.reason);
      if (r.kind === "conflict" && r.slug === "slug-taken") setIssues([{ path: "/slug", message: f.text }]);
      setSaveState({ s: "error", message: f.text });
      return;
    }
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
    // CLIENT MODE sends `fields` only: the BFF refills `seo` and generic blocks from the head, and refuses a client that states
    // them. Protected leaves go back exactly as read (`clientFieldsToSend`); a create starts from nothing, so nothing protected is set.
    const clientFields = clientMode ? clientFieldsToSend(defs, clientMode.editable.fields, mode === "create" ? {} : toWire(stored), sentFields) : null;

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
        r = await api.createAndOpen(scope, clientFields
          ? { collectionKey: collection.key, locale, slug, twinOf: null, fields: toWire(clientFields), blocks: [], note }
          : { collectionKey: collection.key, locale, slug, twinOf: seed?.twinOf ?? null, fields: sentFields, blocks: extraBlocks, seo: sentSeo, note }, routeBase);
      } catch (e) {
        if (isNextRedirect(e)) return; // created, and already on its editor
        throw e;
      }
      if (!mounted.current) return;
      handleWriteFailure(r, "created");
      return;
    }

    if (!item) return;
    const r = await api.saveItem(scope, item.itemId, clientFields
      ? { baseVersion: baseOverride ?? baseVersion, fields: toWire(clientFields), note }
      : { baseVersion: baseOverride ?? baseVersion, fields: sentFields, blocks: extraBlocks, seo: sentSeo, note });
    if (!mounted.current) return;
    if (r.kind === "ok") {
      setItem(r.data.item); setLint(r.data.lint); setBaseVersion(r.data.version.version);
      if (clientMode) setHeadAuthor(clientMode.viewerId);
      setStored(clientFields ?? sentFields);
      setBaseline({ fields: draft.fields, seo: draft.seo });
      setIssues([]); setHeadSeen(null); setConflict(null); setNote("");
      setSaveState({ s: "saved", version: r.data.version.version, unchanged: r.data.unchanged });
      return;
    }
    if (r.kind === "conflict" && r.slug === "version-conflict") {
      if (clientMode) { setSaveState({ s: "idle" }); setClientConflict(true); return; }
      await openConflict(r);
      return;
    }
    handleWriteFailure(r, "saved");
  };

  const openConflict = async (r: Extract<WdResult<unknown>, { kind: "conflict" }>) => {
    setSaveState({ s: "idle" });
    const theirs = item ? await api.getItemHead(scope, item.itemId) : null;
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

  /** Client mode: "Reload" after a 409. The latest version replaces the draft (the banner said so, and the unsaved text stayed on
   *  screen until now so it could be copied). A failed read keeps the draft and says why. */
  const reloadLatest = async () => {
    if (!item) return;
    setRefreshing(true);
    const r = await api.refreshEditor(scope, collection.key, item.slug, item.locale);
    if (!mounted.current) return;
    setRefreshing(false);
    if (r.kind !== "ok") {
      setBanner({ tone: "bad", text: clientRefusal(r, "read").text });
      return;
    }
    adopt(r.data.detail, r.data.authoritative);
    setLoadedAt(r.data.loadedAt);
    setStale(null); setUnconfirmed(null); setClientConflict(false);
    setSaveState({ s: "idle" });
    setBanner({ tone: "info", text: `Reloaded the latest version (v${r.data.detail.version.n}). Your previous edits were replaced.` });
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
      r = await api.createAndOpen(scope, {
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

  /** `seo` is never client-editable (§16j: `clientEditable.seo` is always false), whatever the form's other locks say. */
  const seoLocked = readOnly || clientMode !== undefined;
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
              // A client cannot create a twin: it would copy fields (and seo) that only Gaiada may set.
              if (clientMode) return <span key={l} className="wc-locale wc-locale--missing" data-testid={`missing-locale-${l}`}>{l} · not created yet (Gaiada adds new languages)</span>;
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
            <span className="wc-banner__body"><strong>Couldn&apos;t refresh</strong> — showing what loaded at {formatDateTime(loadedAt)}. Save and publish are disabled until {clientMode ? "the website service" : "WebDesk"} answers again.{!clientMode && <><br /><span className="wc-muted">{stale}</span></>}</span>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={refresh} disabled={refreshing} data-testid="refresh">{refreshing ? "Refreshing…" : "Try again"}</button>
          </div>
        )}
        {unconfirmed !== null && (
          <div className="wc-banner wc-banner--warn" role={clientMode ? "status" : "alert"} data-testid="unconfirmed-banner">
            <span className="wc-banner__body"><strong>{unconfirmed}</strong>{mode === "edit" ? " Your edits are still here." : ""}</span>
            {mode === "edit" && (
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={refresh} disabled={refreshing} data-testid="unconfirmed-reload">{refreshing ? "Reloading…" : "Reload"}</button>
            )}
          </div>
        )}
        {clientConflict && (
          <div className="wc-banner wc-banner--bad" role="status" data-testid="client-conflict">
            <span className="wc-banner__body">
              <strong>{CLIENT_COPY.versionConflict}</strong>
              <br />Your unsaved changes are still on this page, so you can copy them before you reload. Reloading replaces them with the latest version.
            </span>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => void reloadLatest()} disabled={refreshing} data-testid="client-conflict-reload">{refreshing ? "Reloading…" : "Reload"}</button>
          </div>
        )}
        {readOnlyWhy && (
          <div className="wc-banner wc-banner--info" role="note" data-testid="readonly-banner">
            <span className="wc-banner__body"><strong>Read-only.</strong> {readOnlyWhy}</span>
          </div>
        )}
        {headSeen !== null && headSeen > baseVersion && !conflict && !clientConflict && (
          <div className="wc-banner wc-banner--warn" data-testid="behind-head">
            <span className="wc-banner__body">
              {clientMode
                ? <>A newer version (v{headSeen}) was saved since you opened this (you are on v{baseVersion}). Saving will ask you to reload first. Your edits stay on this page until you do, so you can copy them.</>
                : <>v{headSeen} was saved since you opened this (you are on v{baseVersion}). Saving will ask you how to combine them; your edits are kept.</>}
            </span>
          </div>
        )}
        {banner && <div className={`wc-banner wc-banner--${banner.tone}`} role={banner.tone === "bad" && !clientMode ? "alert" : "status"} data-testid="editor-banner"><span className="wc-banner__body">{banner.text}</span></div>}
        {authoritativeNote(bundle)}
        {saveState.s === "error" && (
          <div className="wc-banner wc-banner--bad" role={clientMode ? "status" : "alert"} data-testid="save-error"><span className="wc-banner__body">{saveState.message}
              {/* Every issue, with its pointer: one with no control on this form (an unknown key, a member the
                  composition hides) must still be visible somewhere, never silently counted. */}
              {saveState.issues && saveState.issues.length > 0 && (
                <ul className="wc-errors" data-testid="issue-list">{saveState.issues.map((i, n) => <li key={n}>{clientMode ? i.message : <><code>{i.path || "/"}</code> — {i.message}</>}</li>)}</ul>
              )}
            </span></div>
        )}

        {/* ── create-only: slug ─────────────────────────────────────────────────────────────── */}
        {mode === "create" && (
          <div className="lux-field wc-field">
            <label className="lux-field__label lux-field__label--req" htmlFor="wc-slug">Slug</label>
            <input id="wc-slug" className={`lux-field__control${slugIssues.length ? " lux-field__control--error" : ""}`} value={slug} onChange={(e) => setSlug(e.target.value)} aria-invalid={slugIssues.length > 0 || undefined} aria-describedby="wc-slug-hint" data-pointer="/slug" autoComplete="off" spellCheck={false} />
            <span id="wc-slug-hint" className="lux-field__hint">{clientMode ? <>Used in the page&apos;s address and unchangeable after the page is created. Lowercase letters, digits, dots and hyphens only.</> : <>The item&apos;s stable id, shared by its locale twins and unchangeable after creation (for example <code>service.seo</code>).</>}</span>
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
            <p className="lux-field__hint">{clientMode ? <>The page&apos;s title and description in search results. {CLIENT_COPY.managed}</> : <>The page&apos;s title and description (<code>seo.title</code> / <code>seo.description</code>) — there are no separate copies in the fields above.</>}</p>
            <div className="lux-field wc-field">
              <label className="lux-field__label" htmlFor="wc-seo-title">SEO title</label>
              <input id="wc-seo-title" className={`lux-field__control${seoTitleIssues.length ? " lux-field__control--error" : ""}`} data-pointer="/seo/title" value={typeof draft.seo.title === "string" ? draft.seo.title : ""} readOnly={seoLocked} aria-readonly={seoLocked || undefined} aria-invalid={seoTitleIssues.length > 0 || undefined} onChange={(e) => setDraft((d) => ({ ...d, seo: setOrDrop(d.seo, "title", e.target.value) }))} />
              {seoTitleIssues.map((i, n) => <span key={n} className="lux-field__error">{i.message}</span>)}
            </div>
            <div className="lux-field wc-field">
              <label className="lux-field__label" htmlFor="wc-seo-desc">SEO description</label>
              <textarea id="wc-seo-desc" className={`lux-field__control lux-field__control--textarea${seoDescIssues.length ? " lux-field__control--error" : ""}`} data-pointer="/seo/description" rows={3} value={typeof draft.seo.description === "string" ? draft.seo.description : ""} readOnly={seoLocked} aria-readonly={seoLocked || undefined} aria-invalid={seoDescIssues.length > 0 || undefined} onChange={(e) => setDraft((d) => ({ ...d, seo: setOrDrop(d.seo, "description", e.target.value) }))} />
              {seoDescIssues.map((i, n) => <span key={n} className="lux-field__error">{i.message}</span>)}
            </div>
          </fieldset>
        )}

        {extraBlocks.length > 0 && (
          <p className="lux-field__hint">{clientMode ? <>{extraBlocks.length} more content block{extraBlocks.length === 1 ? "" : "s"} on this page {extraBlocks.length === 1 ? "is" : "are"} kept as {extraBlocks.length === 1 ? "it is" : "they are"}; {extraBlocks.length === 1 ? "it" : "they"} can&apos;t be edited here.</> : <>{extraBlocks.length} vocabulary block{extraBlocks.length === 1 ? "" : "s"} after the fields are kept as they are — they can&apos;t be edited in this form.</>}</p>
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
          {!canWrite && <span id="wc-save-why" className="wc-muted">{readOnly ? "Read-only" : clientConflict ? "Reload first" : unconfirmed !== null && stale === null ? "Disabled until you reload" : say("Disabled until WebDesk answers again")}</span>}
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
                <dt>{clientMode ? "Latest draft" : "Head"}</dt><dd data-testid="item-head">v{item.headVersion}</dd>
                <dt>Live</dt><dd>{item.publishedVersion !== null ? `v${item.publishedVersion}` : "—"}</dd>
                <dt>Updated</dt><dd>{formatDateTime(item.updatedAt)}</dd>
                <dt>Loaded</dt><dd data-testid="loaded-at">{formatDateTime(loadedAt)}</dd>
              </dl>
              <div className="wc-publish__actions">
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={refresh} disabled={refreshing} data-testid="refresh-now">{refreshing ? "Refreshing…" : "Refresh"}</button>
                <Link className="lux-btn lux-btn--ghost lux-btn--sm" href={`${routeBase}/${encodeURIComponent(collection.key)}/${encodeURIComponent(item.slug)}/history?locale=${encodeURIComponent(item.locale)}`}>Version history</Link>
              </div>
            </section>

            {clientMode ? clientMode.renderPublish({
              item,
              version: baseVersion,
              dirty,
              blocked: readOnly ? "Read-only." : stale !== null ? "Disabled until the website service answers again." : unconfirmed !== null ? "Disabled until you reload." : clientConflict ? "Reload first." : null,
              headIsMine: headAuthor !== null && headAuthor === clientMode.viewerId,
              headAuthor: headAuthor === null ? null : authorLabel(headAuthor, authors),
              onItemChanged: (it) => { setItem(it); },
              onUnavailable: goStale,
              onUnconfirmed: (what) => setUnconfirmed(unconfirmedCopy(what)),
            }) : (
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
            )}

            {!clientMode && editorial && (
              <EditorialPanel
                scope={scope}
                itemId={item.itemId}
                version={baseVersion}
                dirty={dirty}
                blocked={item.deletedAt ? "This item has been deleted." : stale !== null ? "Disabled until WebDesk answers again." : unconfirmed !== null ? "Disabled until you reload." : null}
                initial={editorial}
                authors={authors}
                refreshKey={`${loadedAt}|${baseVersion}`}
              />
            )}

            {/* M5-W6: the writing assistant. Offered only when the item read's `allowed.update` is true (the drawer renders nothing otherwise); it
                only ever puts text into the draft as an UNSAVED edit: saving stays this editor's Save. */}
            {!clientMode && !item.deletedAt && (
              <AssistDrawer
                scope={scope}
                itemId={item.itemId}
                allowed={editorial?.allowed}
                baseVersion={baseVersion}
                dirty={dirty}
                ctx={{ defs, draft, locale, defaultLocale: tenant.defaultLocale, seoCarrier, localeNeutralCollection }}
                applyBlocked={readOnly ? "Read-only." : stale !== null ? "Disabled until WebDesk answers again." : unconfirmed !== null ? "Disabled until you reload." : null}
                onApply={(next) => setDraft(next)}
              />
            )}

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

            {!clientMode && <ContentChecksCard lint={lint} />}

            {/* WSK-46: preview the DRAFT on the site's own /preview/ page. Off exactly when Save is off (`canWrite`). */}
            {!item.deletedAt && (
              <PreviewCard
                scope={scope}
                itemId={item.itemId}
                version={baseVersion}
                dirty={dirty}
                blocked={readOnly ? "Read-only." : stale !== null ? say("Disabled until WebDesk answers again.") : unconfirmed !== null ? "Disabled until you reload." : clientConflict ? "Reload first." : null}
                preview={clientMode ? api.previewItem : undefined}
              />
            )}

            {stagingItemUrl && (
              <section className="wc-side-card"><h3>Staging</h3><a href={stagingItemUrl} target="_blank" rel="noopener noreferrer" data-testid="view-staging">View on staging</a></section>
            )}

            {!clientMode && !isLive(item) && !item.deletedAt && !readOnly && (
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
            <p className="wc-publish__sub">{clientMode ? "A new page starts as a draft. Once it is created you can publish it, or include it in a publish request." : "A new item starts as a draft. Publishing is requested after it is created."}</p>
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
