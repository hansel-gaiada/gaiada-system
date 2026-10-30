"use client";
// SCP-5e (BFF §63.26): "Add to the bank". Three ways in, each a shape the bank stores: a link (a Drive or web link, which is how every VIDEO is kept: the Asset Library stores images only, SCP-Q30),
// a text (a caption or a template) and a photo picked from the Asset Library. A design's photo, an approved post and a hashtag set are read from where they live and are never added here.
// The server's `canAdd` decides whether the form is drawn at all (adding is the Social Media team's, SCP-Q29); a refusal of the add itself is said in words under the button. The form checks the
// server's own shapes first (`buildSavedCreate`), so a mistake is named before a request is made, and sends a fresh `id`, so a double click is the same item.
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefusalNote } from "@/components/social/PostRefusal";
import { addSavedItem } from "@/lib/socialSavedActions";
import { SOURCES, SOURCE_LABEL, type AssetChoice, type Refusal } from "@/lib/socialPipeline";
import { newUuid } from "@/lib/socialClient";
import {
  HOLDS_LABEL, MEDIA_LABEL, MEDIA, SAVED_ADD_REASON, SAVED_LIMITS, buildSavedCreate, defaultHolds, emptyAddForm, storableCollections,
  type SavedAddForm as AddForm, type SavedCollection, type SavedHolds,
} from "@/lib/socialSaved";
import "./cycles.css";
import "./saved.css";

export function SavedAddForm({
  engagementId, collections, canAdd, pillars, assets, initialCategory,
}: {
  engagementId: string;
  collections: readonly SavedCollection[];
  /** The server's answer to "may this person add?". False draws the sentence on who may, and no form. */
  canAdd: boolean;
  pillars: readonly string[];
  /** The Asset Library's latest versions; null when the library could not be read (the photo way in then says so). */
  assets: ReadonlyArray<AssetChoice> | null;
  /** The collection open on the page, offered first. */
  initialCategory: string | null;
}) {
  const uid = useId();
  const router = useRouter();
  const targets = storableCollections(collections);
  const first = targets.find((c) => c.key === initialCategory) ?? targets[0] ?? null;
  const [form, setForm] = useState<AddForm>(() => emptyAddForm(first?.key ?? "", first ? defaultHolds(first) : "text"));
  const [refusal, setRefusal] = useState<{ refusal: Refusal; message: string } | null>(null);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!canAdd) return <p className="scp-note scp-note--reason">{SAVED_ADD_REASON} You can read everything here.</p>;
  if (targets.length === 0) return <p className="scp-note">This company's collections store nothing to add to: they are all read from the designs, the posts and the brand book.</p>;
  const target = targets.find((c) => c.key === form.category) ?? targets[0];

  const set = <K extends keyof AddForm>(k: K, v: AddForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  function pickCollection(key: string) {
    const c = targets.find((x) => x.key === key);
    if (!c) return;
    setForm((f) => ({ ...f, category: key, holds: c.holds.includes(f.holds) ? f.holds : defaultHolds(c) }));
  }

  function add() {
    setRefusal(null);
    setDone(null);
    const check = buildSavedCreate(form, newUuid());
    if (!check.ok) { setProblem({ field: check.field, message: check.message }); return; }
    setProblem(null);
    start(async () => {
      const r = await addSavedItem(engagementId, check.body);
      if (!r.ok) { setRefusal({ refusal: r.refusal, message: r.message }); return; }
      setDone(r.created ? `Saved "${r.item.title}".` : `"${r.item.title}" was already in the bank, so nothing new was added.`);
      setForm(emptyAddForm(form.category, form.holds));
      router.refresh();
    });
  }

  const err = (field: string) => (problem?.field === field ? problem.message : null);
  return (
    <details className="scp-saved__add">
      <summary>Add to the bank</summary>
      <form className="scp-saved__form" aria-label="Add to the content bank" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <div className="scp-saved__row">
          <div className="scp-field">
            <label htmlFor={`${uid}-cat`}>Collection</label>
            <select id={`${uid}-cat`} className="scp-input" value={target.key} onChange={(e) => pickCollection(e.target.value)}>
              {targets.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          {target.holds.length > 1 && (
            <div className="scp-field">
              <label htmlFor={`${uid}-holds`}>What you are saving</label>
              <select id={`${uid}-holds`} className="scp-input" value={form.holds} onChange={(e) => set("holds", e.target.value as SavedHolds)}>
                {target.holds.map((h) => <option key={h} value={h}>{HOLDS_LABEL[h]}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="scp-field">
          <label htmlFor={`${uid}-title`}>Title</label>
          <input id={`${uid}-title`} className="scp-input" value={form.title} maxLength={SAVED_LIMITS.title} aria-invalid={err("title") ? true : undefined} onChange={(e) => set("title", e.target.value)} />
          {err("title") && <span className="scp-msg scp-msg--error" role="alert">{err("title")}</span>}
        </div>
        {form.holds === "text" && (
          <div className="scp-field">
            <label htmlFor={`${uid}-body`}>Text</label>
            <textarea id={`${uid}-body`} className="scp-input scp-saved__text" value={form.body} maxLength={SAVED_LIMITS.body} aria-invalid={err("body") ? true : undefined} onChange={(e) => set("body", e.target.value)} />
            {err("body") && <span className="scp-msg scp-msg--error" role="alert">{err("body")}</span>}
          </div>
        )}
        {form.holds === "link" && (
          <>
            <div className="scp-saved__row">
              <div className="scp-field">
                <label htmlFor={`${uid}-url`}>Link</label>
                <input id={`${uid}-url`} className="scp-input" inputMode="url" placeholder="https://" value={form.url} maxLength={SAVED_LIMITS.url} aria-invalid={err("url") ? true : undefined} onChange={(e) => set("url", e.target.value)} />
                {err("url") && <span className="scp-msg scp-msg--error" role="alert">{err("url")}</span>}
                <span className="scp-field__hint">Videos are kept as a Drive link: the Asset Library stores images only. Anyone on the team who opens it needs access to the file.</span>
              </div>
              <div className="scp-field">
                <label htmlFor={`${uid}-media`}>It points at</label>
                <select id={`${uid}-media`} className="scp-input" value={form.media} onChange={(e) => set("media", e.target.value as AddForm["media"])}>
                  <option value="">Not said</option>
                  {MEDIA.map((m) => <option key={m} value={m}>{MEDIA_LABEL[m]}</option>)}
                </select>
              </div>
              <div className="scp-field">
                <label htmlFor={`${uid}-source`}>Where it comes from</label>
                <select id={`${uid}-source`} className="scp-input" value={form.source} aria-invalid={err("source") ? true : undefined} onChange={(e) => set("source", e.target.value as AddForm["source"])}>
                  <option value="">Choose…</option>
                  {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                </select>
                {err("source") && <span className="scp-msg scp-msg--error" role="alert">{err("source")}</span>}
              </div>
            </div>
            {(form.source === "ai" || form.aiNote !== "") && (
              <div className="scp-field">
                <label htmlFor={`${uid}-note`}>AI note</label>
                <textarea id={`${uid}-note`} className="scp-input scp-saved__text" value={form.aiNote} maxLength={SAVED_LIMITS.aiNote} aria-invalid={err("aiNote") ? true : undefined} onChange={(e) => set("aiNote", e.target.value)} />
                {err("aiNote") ? <span className="scp-msg scp-msg--error" role="alert">{err("aiNote")}</span> : <span className="scp-field__hint">Say how the AI was used. A link made with AI needs this note.</span>}
              </div>
            )}
          </>
        )}
        {form.holds === "asset" && (
          <div className="scp-field">
            <label htmlFor={`${uid}-asset`}>Asset Library photo</label>
            {assets === null ? (
              <span className="scp-note" role="status" style={{ margin: 0 }}>The Asset Library could not be read just now, so a photo cannot be picked. Add it as a link instead.</span>
            ) : assets.length === 0 ? (
              <span className="scp-note" style={{ margin: 0 }}>The Asset Library has no saved assets yet.</span>
            ) : (
              <select id={`${uid}-asset`} className="scp-input" value={form.assetGroupId} aria-invalid={err("assetGroupId") ? true : undefined} onChange={(e) => set("assetGroupId", e.target.value)}>
                <option value="">Choose…</option>
                {assets.map((a) => <option key={a.groupId} value={a.groupId}>{`${a.name} (version ${a.versionNo})`}</option>)}
              </select>
            )}
            {err("assetGroupId") && <span className="scp-msg scp-msg--error" role="alert">{err("assetGroupId")}</span>}
            <span className="scp-field__hint">A photo already kept for this client is not added twice.</span>
          </div>
        )}
        <div className="scp-field">
          <label htmlFor={`${uid}-pillar`}>Pillar (optional)</label>
          <select id={`${uid}-pillar`} className="scp-input" value={form.pillar} onChange={(e) => set("pillar", e.target.value)}>
            <option value="">No pillar</option>
            {pillars.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="scp-saved__actions">
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || (form.holds === "asset" && (assets === null || assets.length === 0))}>{pending ? "Saving…" : "Save to the bank"}</button>
          {done && <span className="scp-msg scp-msg--ok" role="status">{done}</span>}
        </div>
        {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.message} />}
      </form>
    </details>
  );
}
