"use client";
// SCP-5e (BFF §63.26): one STORED item of the content bank (a caption, a template, a reference, a kept link or a kept Asset Library photo), with its card, its edit form and its delete.
// Changing or deleting is the item's author's, else the client's officer, the HoD, the GM, the owner or the superadmin (SCP-Q29); the server decides (403 `not_officer_or_approver`), so the buttons
// are drawn for everyone and a refusal is said in words beside them. A video is a Drive link (SCP-Q30), shown as a link, never as a player. Nothing here reads the item as an image unless it is an
// Asset Library photo: a link opens in a new tab.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { updateSavedItem, deleteSavedItem } from "@/lib/socialSavedActions";
import { SOURCES, SOURCE_LABEL, type Refusal } from "@/lib/socialPipeline";
import { formatDate } from "@/lib/format";
import {
  HOLDS_LABEL, MEDIA_LABEL, OTHER_KEY, SAVED_CHANGE_REASON, SAVED_LIMITS, buildSavedPatch, editFormOf, imageHref, sourceWords, useWords,
  type SavedCollection, type SavedEditForm, type SavedItem,
} from "@/lib/socialSaved";
import "./cycles.css";
import "./saved.css";

const SHORT = 240;

export function SavedItemCard({
  item, viewerId, pillars, collections, usedWords, onGrid = false,
}: {
  item: SavedItem;
  /** The signed-in person, to say which items are theirs. The server still decides. */
  viewerId: string;
  /** The client's brand-book pillars, for the pillar field. */
  pillars: readonly string[];
  /** The company's collections, so an item left under "Other" can be moved into one that takes it. */
  collections: readonly SavedCollection[];
  /** The "Used …" line, when it differs from the item's own use count (a kept photo counts posts that use it). */
  usedWords?: string;
  onGrid?: boolean;
}) {
  const uid = useId();
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [form, setForm] = useState<SavedEditForm>(() => editFormOf(item));
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const mine = item.addedBy?.id === viewerId;
  const moveTo = collections.filter((c) => c.key !== OTHER_KEY && c.holds.includes(item.holds));

  const set = <K extends keyof SavedEditForm>(k: K, v: SavedEditForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const close = () => { setMode("view"); setRefusal(null); setProblem(null); setForm(editFormOf(item)); };

  function save() {
    setRefusal(null);
    const check = buildSavedPatch(item, form);
    if (!check.ok) { setProblem(check.message); return; }
    setProblem(null);
    start(async () => {
      const r = await updateSavedItem(item.id, check.body);
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      setMode("view");
      router.refresh();
    });
  }

  function remove() {
    setRefusal(null);
    start(async () => {
      const r = await deleteSavedItem(item.id);
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      router.refresh();
    });
  }

  const long = item.body !== null && [...item.body].length > SHORT;
  return (
    <article className="scp-saved__card" aria-label={item.title}>
      {item.asset ? (
        <span className="scp-saved__media">
          <span className="scp-saved__ph" aria-hidden="true">{item.title}</span>
          {/* eslint-disable-next-line @next/next/no-img-element -- the asset route streams the stored bytes; the card's title names it */}
          <img src={imageHref(item.asset.versionId)} alt="" loading="lazy" decoding="async" />
        </span>
      ) : item.holds === "link" && onGrid ? (
        <span className="scp-saved__media"><span className="scp-saved__ph">{item.media === "video" ? "Video, on Drive" : "Photo link"}</span></span>
      ) : null}
      <h4 className="scp-saved__title">{item.title}</h4>
      <p className="scp-saved__meta">
        <span className="scp-saved__badge">{item.holds === "link" && item.media ? `${MEDIA_LABEL[item.media]} link` : HOLDS_LABEL[item.holds]}</span>
        <span className={item.used ? "scp-saved__badge scp-saved__badge--used" : "scp-saved__badge"}>{usedWords ?? useWords(item)}</span>
        {item.holds !== "text" && <span>{sourceWords(item.source)}</span>}
        {item.pillar && <span>Pillar: {item.pillar}</span>}
      </p>
      {item.aiNote && <p className="scp-saved__meta">AI note: {item.aiNote}</p>}
      {item.body !== null && (long ? (
        <details>
          <summary className="scp-saved__body">{[...item.body].slice(0, SHORT).join("")}… <span className="scp-link">Read all</span></summary>
          <p className="scp-saved__body">{item.body}</p>
        </details>
      ) : <p className="scp-saved__body">{item.body}</p>)}
      {item.url && <p className="scp-saved__meta"><a className="scp-link" href={item.url} target="_blank" rel="noopener noreferrer">Open the link (new tab)</a></p>}
      <p className="scp-saved__meta">
        <span>{item.addedBy ? `Added by ${item.addedBy.name}${mine ? " (you)" : ""}` : "Added"}{item.addedAt ? ` on ${formatDate(item.addedAt)}` : ""}</span>
      </p>

      {mode === "view" && (
        <div className="scp-saved__actions">
          <button type="button" className="lux-btn lux-btn--sm" onClick={() => setMode("edit")}>Edit</button>
          <button type="button" className="lux-btn lux-btn--sm" onClick={() => setMode("delete")}>Delete</button>
        </div>
      )}
      {mode === "view" && !mine && <p className="scp-field__hint">{SAVED_CHANGE_REASON}</p>}

      {mode === "delete" && (
        <div className="scp-saved__actions" role="group" aria-label={`Delete ${item.title}`}>
          <span className="scp-note" style={{ margin: 0 }}>Delete this item from the bank? It is removed for everyone on the team.</span>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={remove}>{pending ? "Deleting…" : "Yes, delete it"}</button>
          <button type="button" className="lux-btn lux-btn--sm" disabled={pending} onClick={close}>Keep it</button>
        </div>
      )}

      {mode === "edit" && (
        <form className="scp-saved__form" aria-label={`Edit ${item.title}`} onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="scp-field">
            <label htmlFor={`${uid}-title`}>Title</label>
            <input id={`${uid}-title`} className="scp-input" value={form.title} maxLength={SAVED_LIMITS.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          {item.holds === "text" && (
            <div className="scp-field">
              <label htmlFor={`${uid}-body`}>Text</label>
              <textarea id={`${uid}-body`} className="scp-input scp-saved__text" value={form.body} maxLength={SAVED_LIMITS.body} onChange={(e) => set("body", e.target.value)} />
            </div>
          )}
          {item.holds === "link" && (
            <>
              <div className="scp-field">
                <label htmlFor={`${uid}-source`}>Where it comes from</label>
                <select id={`${uid}-source`} className="scp-input" value={form.source} onChange={(e) => set("source", e.target.value)}>
                  {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                </select>
              </div>
              {(form.source === "ai" || form.aiNote !== "") && (
                <div className="scp-field">
                  <label htmlFor={`${uid}-note`}>AI note</label>
                  <textarea id={`${uid}-note`} className="scp-input scp-saved__text" value={form.aiNote} maxLength={SAVED_LIMITS.aiNote} onChange={(e) => set("aiNote", e.target.value)} />
                  <span className="scp-field__hint">Say how the AI was used. A link made with AI needs this note.</span>
                </div>
              )}
            </>
          )}
          <div className="scp-field">
            <label htmlFor={`${uid}-pillar`}>Pillar</label>
            <select id={`${uid}-pillar`} className="scp-input" value={form.pillar} onChange={(e) => set("pillar", e.target.value)}>
              <option value="">No pillar</option>
              {[...new Set([...(form.pillar && !pillars.includes(form.pillar) ? [form.pillar] : []), ...pillars])].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {!collections.some((c) => c.key === item.category) ? (
            <div className="scp-field">
              <label htmlFor={`${uid}-cat`}>Move to</label>
              <select id={`${uid}-cat`} className="scp-input" value={form.category} onChange={(e) => set("category", e.target.value)}>
                <option value={item.category}>Stay under Other</option>
                {moveTo.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <span className="scp-field__hint">Its collection is no longer one of the company&apos;s. Move it into one.</span>
            </div>
          ) : null}
          {problem && <p className="scp-msg scp-msg--error" role="alert">{problem}</p>}
          <div className="scp-saved__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
            <button type="button" className="lux-btn lux-btn--sm" disabled={pending} onClick={close}>Cancel</button>
          </div>
        </form>
      )}
      {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
    </article>
  );
}
