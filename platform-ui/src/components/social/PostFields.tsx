"use client";
// SCP-1e, 1f (BFF §63.6.3, §63.6.4) — the post page's Post and Creative brief tabs: one row per field, and the Copywriter's suggestions on the copy rows.
//
// A ROW IS EDITABLE ONLY WHEN THE TWIN SAYS SO. `editableFieldsOf` reads the fixture's `editRules` for the post's status (and change case), and the person must be
// the client's officer (the read's own `actions[]` say so: `canAuthorPost`). A save goes through `PATCH posts/:postId/pipeline` with `expectedStatus`; a refusal
// (`field_locked`, `status_changed`) comes back in words beside the row. A locked row says why: the date and the networks of an approved or scheduled post are
// Reschedule's, which asks the client again.
//
// USE FROM SAVED (SCP-5e): above the tabs, a picker over the client's content bank (`PostUseSaved.tsx`); the edit it sends is this same `PATCH posts/:postId/pipeline` with `savedItemIds`.
//
// SUGGESTIONS (1f). While a post is in proofread the Copywriter's edits are suggestions, one per copy field (`PUT` / `DELETE posts/:postId/suggestions/:field`).
// The officer sees them while drafting or fixing, each with its stale flag (the field changed since it was suggested) and an "Accept" button (the
// `accept_suggestion` action, logged as via suggestion). "Approve copy" in the action bar applies the rest.
import { useId, useState, useTransition } from "react";
import { UseFromSaved } from "@/components/social/PostUseSaved";
import { RefusalNote } from "@/components/social/PostRefusal";
import { formatDateTime } from "@/lib/format";
import {
  FIELD_SPECS, MUST_HAVES, NETWORKS, SOURCE_LABEL, SOURCES, SUGGESTIBLE_FIELDS, canAuthorPost, canSuggest, editableFieldsOf, isoToZoneInput, lockedWords, networkLabel, newActionId,
  statusLabel, zoneInputToIso, type FieldSpec, type PipelinePost, type RawAsset,
} from "@/lib/socialPipeline";
import { dropSuggestion, runPostAction, savePostFields, saveSuggestion, type WriteResult } from "@/lib/socialPipelineActions";

type Failed = Extract<WriteResult, { ok: false }>;
type Report = (r: WriteResult, label: string) => void;

const FORMAT_CHOICES = ["feed", "carousel", "reel", "story"];
const FORMAT_LABEL: Record<string, string> = { feed: "Feed post", carousel: "Carousel", reel: "Reel", story: "Story" };

// ── Display ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function valueOf(post: PipelinePost, key: string): unknown { return (post as unknown as Record<string, unknown>)[key]; }

function Display({ spec, post }: { spec: FieldSpec; post: PipelinePost }) {
  const v = valueOf(post, spec.key);
  const empty = <span className="scp-row__value--empty">Not set</span>;
  switch (spec.kind) {
    case "hashtags": return (v as string[]).length ? <>{(v as string[]).map((h) => `#${h}`).join(" ")}</> : empty;
    case "datetime": return v ? <>{formatDateTime(String(v))}</> : empty;
    case "networks": return (v as string[]).length ? <>{(v as string[]).map(networkLabel).join(", ")}</> : empty;
    case "format": return v ? <>{FORMAT_LABEL[String(v)] ?? String(v)}</> : empty;
    case "musthaves": {
      const ticked = new Set(v as string[]);
      const open = MUST_HAVES.filter((m) => !ticked.has(m.key)).map((m) => m.label);
      return <>{`${ticked.size} of ${MUST_HAVES.length} ticked`}{open.length > 0 && <span className="scp-field__hint"> Not yet: {open.join(", ")}.</span>}</>;
    }
    case "rawassets": {
      const list = v as RawAsset[];
      if (!list.length) return empty;
      return (
        <>
          {list.map((a, n) => (
            <span key={n} style={{ display: "block" }}>
              {a.label || `Image ${n + 1}`} · {SOURCE_LABEL[a.source] ?? a.source}
              {a.url && !a.url.startsWith("data:") && <> · <a href={a.url} target="_blank" rel="noopener noreferrer">link</a></>}
              {a.aiNote && <span className="scp-field__hint"> AI note: {a.aiNote}</span>}
            </span>
          ))}
        </>
      );
    }
    default: return v === null || v === undefined || v === "" ? empty : <>{String(v)}</>;
  }
}

const suggestionText = (v: unknown): string => (Array.isArray(v) ? v.map((h) => `#${String(h)}`).join(" ") : v === null || v === undefined ? "" : String(v));

// ── The editor of one field ──────────────────────────────────────────────────────────────────────────────────────────────────

type Draft = string | string[] | RawAsset[];

function initialDraft(spec: FieldSpec, post: PipelinePost, suggestion?: unknown): Draft {
  const v = suggestion !== undefined ? suggestion : valueOf(post, spec.key);
  switch (spec.kind) {
    case "hashtags": return Array.isArray(v) ? v.map(String).join(" ") : "";
    case "datetime": return isoToZoneInput(typeof v === "string" ? v : null);
    case "networks": case "musthaves": return Array.isArray(v) ? [...(v as string[])] : [];
    case "rawassets": return (v as RawAsset[]).map((a) => ({ ...a }));
    default: return typeof v === "string" ? v : "";
  }
}

const tokens = (s: string): string[] => s.split(/[\s,]+/).map((t) => t.replace(/^#+/, "")).filter(Boolean);

/** The value to send for a draft, or the words for why it cannot be sent. The server checks again. */
function toValue(spec: FieldSpec, draft: Draft, forSuggestion: boolean): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (spec.kind) {
    case "hashtags": {
      const t = tokens(draft as string);
      if (t.length > 60) return { ok: false, message: "A post takes at most 60 hashtags." };
      return { ok: true, value: t };
    }
    case "datetime": {
      const s = draft as string;
      if (s === "") return { ok: true, value: null };
      const iso = zoneInputToIso(s);
      return iso ? { ok: true, value: iso } : { ok: false, message: "Give a real date and time." };
    }
    case "networks": case "musthaves": return { ok: true, value: draft };
    case "format": return { ok: true, value: (draft as string) === "" ? null : draft };
    case "rawassets": {
      const list = (draft as RawAsset[]).map((a) => ({ url: a.url.trim(), label: a.label.trim(), source: a.source, aiNote: a.source === "ai" ? (a.aiNote ?? "").trim() || null : null }));
      if (list.some((a) => a.source === "ai" && !a.aiNote)) return { ok: false, message: "An image made with AI needs a note on how." };
      return { ok: true, value: list };
    }
    default: {
      const s = draft as string;
      if (spec.max && [...s].length > spec.max) return { ok: false, message: `${spec.label} can be at most ${spec.max} characters.` };
      if (spec.key === "title" && s.trim() === "") return { ok: false, message: "The title cannot be empty." };
      if (spec.key === "title" || spec.key === "caption" || forSuggestion) return { ok: true, value: spec.key === "title" ? s.trim() : s };
      return { ok: true, value: s.trim() === "" ? null : s };
    }
  }
}

function Editor({ spec, draft, setDraft }: { spec: FieldSpec; draft: Draft; setDraft: (d: Draft) => void }) {
  const id = useId();
  switch (spec.kind) {
    case "longtext":
      return <textarea id={id} aria-label={spec.label} className="scp-input" value={draft as string} onChange={(e) => setDraft(e.target.value)} />;
    case "format":
      return (
        <select id={id} aria-label={spec.label} className="scp-input" value={draft as string} onChange={(e) => setDraft(e.target.value)}>
          <option value="">Not set</option>
          {FORMAT_CHOICES.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
        </select>
      );
    case "datetime":
      return <input id={id} aria-label={spec.label} className="scp-input" type="datetime-local" value={draft as string} onChange={(e) => setDraft(e.target.value)} />;
    case "hashtags":
      return (
        <>
          <input id={id} aria-label={spec.label} className="scp-input" type="text" value={draft as string} onChange={(e) => setDraft(e.target.value)} />
          <span className="scp-field__hint">Separate them with spaces. The # sign is added for you.</span>
        </>
      );
    case "networks":
      return (
        <fieldset className="scp-checks" aria-label={`Choose ${spec.label.toLowerCase()}`}>
          {NETWORKS.map((n) => (
            <label key={n}>
              <input
                type="checkbox" checked={(draft as string[]).includes(n)}
                onChange={(e) => setDraft(e.target.checked ? [...(draft as string[]), n] : (draft as string[]).filter((x) => x !== n))}
              />
              {networkLabel(n)}
            </label>
          ))}
        </fieldset>
      );
    case "musthaves":
      return (
        <fieldset className="scp-checks" aria-label={`Choose ${spec.label.toLowerCase()}`}>
          {MUST_HAVES.map((m) => (
            <label key={m.key}>
              <input
                type="checkbox" checked={(draft as string[]).includes(m.key)}
                onChange={(e) => setDraft(e.target.checked ? [...(draft as string[]), m.key] : (draft as string[]).filter((x) => x !== m.key))}
              />
              {m.label}
            </label>
          ))}
        </fieldset>
      );
    case "rawassets": {
      const list = draft as RawAsset[];
      const patch = (n: number, p: Partial<RawAsset>) => setDraft(list.map((a, k) => (k === n ? { ...a, ...p } : a)));
      return (
        <>
          {list.map((a, n) => (
            <div key={n} className="scp-rawasset">
              <input className="scp-input" aria-label={`Image ${n + 1} link`} type="url" placeholder="https://" value={a.url} onChange={(e) => patch(n, { url: e.target.value })} />
              <input className="scp-input" aria-label={`Image ${n + 1} label`} type="text" placeholder="Label" value={a.label} onChange={(e) => patch(n, { label: e.target.value })} />
              <select className="scp-input" aria-label={`Image ${n + 1} source`} value={a.source} onChange={(e) => patch(n, { source: e.target.value })}>
                {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
              </select>
              {a.source === "ai" && <input className="scp-input" aria-label={`Image ${n + 1} AI note`} type="text" placeholder="How it was made" value={a.aiNote ?? ""} onChange={(e) => patch(n, { aiNote: e.target.value })} />}
              <button type="button" className="scp-link" onClick={() => setDraft(list.filter((_, k) => k !== n))}>Remove image {n + 1}</button>
            </div>
          ))}
          <div className="scp-row__buttons">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={list.length >= 10} onClick={() => setDraft([...list, { url: "", label: "", source: "own", aiNote: null }])}>Add an image</button>
          </div>
        </>
      );
    }
    default:
      return <input id={id} aria-label={spec.label} className="scp-input" type="text" value={draft as string} onChange={(e) => setDraft(e.target.value)} />;
  }
}

// ── One row ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function FieldRow({ spec, post, editable, lock, onResult }: { spec: FieldSpec; post: PipelinePost; editable: boolean; lock: string; onResult: Report }) {
  const [mode, setMode] = useState<"edit" | "suggest" | null>(null);
  const [draft, setDraft] = useState<Draft>("");
  const [error, setError] = useState<Failed | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const suggestible = SUGGESTIBLE_FIELDS.includes(spec.key);
  const sug = suggestible ? post.suggestions[spec.key] : undefined;
  const mayAccept = !!sug && post.actions.some((a) => a.action === "accept_suggestion" && a.allowed);
  const maySuggest = suggestible && canSuggest(post) && post.pipelineStatus === "proofread";
  const before = post.copyBefore && suggestible ? (post.copyBefore as Record<string, unknown>)[spec.key] : undefined;

  function open(m: "edit" | "suggest") {
    setError(null); setLocal(null);
    setDraft(initialDraft(spec, post, m === "suggest" ? sug?.value : undefined));
    setMode(m);
  }
  function save() {
    const v = toValue(spec, draft, mode === "suggest");
    if (!v.ok) { setLocal(v.message); return; }
    setLocal(null); setError(null);
    start(async () => {
      const r = mode === "suggest"
        ? await saveSuggestion(post.id, spec.key, post.pipelineStatus, v.value)
        : await savePostFields(post.id, post.pipelineStatus, { [spec.key]: v.value });
      onResult(r, mode === "suggest" ? "Suggestion saved" : `${spec.label} saved`);
      if (r.ok) setMode(null); else setError(r);
    });
  }
  function drop() {
    setError(null);
    start(async () => {
      const r = await dropSuggestion(post.id, spec.key);
      onResult(r, "Suggestion dropped");
      if (!r.ok) setError(r);
    });
  }
  function accept() {
    setError(null);
    start(async () => {
      const r = await runPostAction(post.id, { action: "accept_suggestion", expectedStatus: post.pipelineStatus, actionId: newActionId(), field: spec.key });
      onResult(r, "Suggestion accepted");
      if (!r.ok) setError(r);
    });
  }

  return (
    <div className="scp-row" role="group" aria-label={spec.label}>
      <p className="scp-row__label">{spec.label}</p>
      <p className="scp-row__value"><Display spec={spec} post={post} /></p>
      <div className="scp-row__tools">
        {editable && mode === null && <button type="button" className="scp-link" onClick={() => open("edit")} aria-label={`Edit ${spec.label}`}>Edit</button>}
        {maySuggest && mode === null && <button type="button" className="scp-link" onClick={() => open("suggest")} aria-label={`Suggest an edit to ${spec.label}`}>{sug ? "Change my suggestion" : "Suggest an edit"}</button>}
        {!editable && !maySuggest && <span className="scp-row__lock" title={lock}>{spec.key === "scheduledAt" || spec.key === "placement" ? lock : "Locked"}</span>}
      </div>
      {before !== undefined && post.changedOnly && (
        <p className="scp-field__hint" style={{ gridColumn: "2 / -1", margin: 0 }}>The client saw: {suggestionText(before) || "nothing"}</p>
      )}
      {sug && (
        <div className="scp-suggest">
          <span className="scp-suggest__by">Suggested{sug.by ? ` by ${sug.by.name}` : ""}</span>
          <p className="scp-suggest__value">{suggestionText(sug.value) || "(empty)"}</p>
          {sug.stale && <span className="scp-suggest__stale">Out of date: the text changed after this was suggested.</span>}
          <div className="scp-row__buttons">
            {mayAccept && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={accept} aria-label={`Accept the suggestion for ${spec.label}`}>Accept</button>}
            {maySuggest && <button type="button" className="scp-link" disabled={pending} onClick={drop} aria-label={`Drop the suggestion for ${spec.label}`}>Drop</button>}
          </div>
        </div>
      )}
      {mode !== null && (
        <div className="scp-row__editor">
          <Editor spec={spec} draft={draft} setDraft={setDraft} />
          {local && <p className="scp-msg scp-msg--error" role="alert">{local}</p>}
          {error && <RefusalNote refusal={error.refusal} message={error.message} />}
          <div className="scp-row__buttons">
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={save}>{pending ? "Saving…" : mode === "suggest" ? "Save suggestion" : "Save"}</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}
      {mode === null && error && <div style={{ gridColumn: "1 / -1" }}><RefusalNote refusal={error.refusal} message={error.message} /></div>}
    </div>
  );
}

// ── The tabs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function PostFields({ post, onResult }: { post: PipelinePost; onResult: Report }) {
  const [tab, setTab] = useState<"post" | "brief">("post");
  const author = canAuthorPost(post);
  const allowed = new Set(editableFieldsOf(post).fields);
  const rows = FIELD_SPECS.filter((s) => s.tab === tab);
  const noneEditable = !FIELD_SPECS.some((s) => allowed.has(s.key) && author);

  return (
    <div>
      {/* SCP-5e (BFF §63.26.3): "Use from Saved", drawn only where the edit rules let the officer change the copy or the reference images. */}
      <UseFromSaved post={post} author={author} onResult={onResult} />
      <div className="scp-tabs" role="tablist" aria-label="The post">
        <button type="button" role="tab" id="scp-tab-post" aria-selected={tab === "post"} aria-controls="scp-panel" className="scp-tabs__tab" onClick={() => setTab("post")}>Post</button>
        <button type="button" role="tab" id="scp-tab-brief" aria-selected={tab === "brief"} aria-controls="scp-panel" className="scp-tabs__tab" onClick={() => setTab("brief")}>Creative brief</button>
      </div>
      <div role="tabpanel" id="scp-panel" aria-labelledby={`scp-tab-${tab}`} className="scp-rows">
        {noneEditable && post.pipelineStatus !== "proofread" && (
          <p className="scp-note" style={{ margin: "0 0 4px" }}>
            {author ? `The fields are read-only at ${post.pipelineStatus === "changes" ? "this change" : statusLabel(post.pipelineStatus)}.` : "Only the client's officer edits these fields."}
          </p>
        )}
        {rows.map((s) => (
          <FieldRow
            key={s.key} spec={s} post={post} editable={author && allowed.has(s.key)}
            lock={allowed.has(s.key) && !author ? "Only the client's officer can edit this." : lockedWords(post, s.key)} onResult={onResult}
          />
        ))}
      </div>
    </div>
  );
}
