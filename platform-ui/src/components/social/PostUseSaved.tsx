"use client";
// SCP-5e (BFF §63.26.3, "Use in a post") — "Use from Saved" on the post page: a button, shown only where the fixture's `editRules` let the person edit the copy or the reference images, that opens a picker
// over the client's Saved content bank. The picker is a labelled dialog (the existing `Modal`): the company's categories as groups, a search, each item a labelled checkbox with its preview and its use count,
// 1 to 10 chosen. On confirm the page sends the post edit (`PATCH posts/:postId/pipeline`) with the changed copy or reference images and `savedItemIds`; the SERVER counts each use in the edit's own transaction,
// and a refusal (another client's item, a step that no longer takes the edit) is said beside the picker with nothing counted. Where the read does not say, the server decides.
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { Modal } from "@/components/overlay/Modal";
import { RefusalNote } from "@/components/social/PostRefusal";
import { newActionId, type PipelinePost, type Refusal } from "@/lib/socialPipeline";
import { savePostFields, type WriteResult } from "@/lib/socialPipelineActions";
import { loadSavedPicker, type SavedPickerData } from "@/lib/socialSavedActions";
import { imageHref } from "@/lib/socialSaved";
import {
  SAVED_USE_MAX, buildUseInPost, canUseFromSaved, chosenWords, entryMeta, goesWords, pickerGroups, searchGroups, unusableWords, useRefusalText,
  type PickEntry, type PickGroup,
} from "@/lib/socialSavedUse";

const SHORT = 140;
const preview = (e: PickEntry): string => {
  if (e.holds === "text") { const t = (e.body ?? "").trim(); return [...t].length > SHORT ? `${[...t].slice(0, SHORT).join("")}…` : t; }
  if (e.holds === "hashtags") return e.tags.slice(0, 8).map((t) => `#${t.replace(/^#+/, "")}`).join(" ") + (e.tags.length > 8 ? " …" : "");
  if (e.holds === "link") return e.url ?? "";
  return "";
};

type Loaded = { state: "loading" } | { state: "unknown" } | { state: "ready"; groups: PickGroup[] };

function Picker({ post, author, onClose, onResult }: { post: PipelinePost; author: boolean; onClose: () => void; onResult: (r: WriteResult, label: string) => void }) {
  const uid = useId();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [local, setLocal] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ refusal: Refusal; text: string } | null>(null);
  const [pending, start] = useTransition();
  const actionId = useRef(newActionId());

  useEffect(() => {
    let live = true;
    void loadSavedPicker(post.engagementId).then(
      (d: SavedPickerData | null) => { if (live) setLoaded(d ? { state: "ready", groups: pickerGroups(d.collections, d.pages) } : { state: "unknown" }); },
      () => { if (live) setLoaded({ state: "unknown" }); },
    );
    return () => { live = false; };
  }, [post.engagementId]);

  const all = useMemo(() => (loaded.state === "ready" ? loaded.groups.flatMap((g) => g.entries) : []), [loaded]);
  const shown = useMemo(() => (loaded.state === "ready" ? searchGroups(loaded.groups, q) : []), [loaded, q]);
  const full = chosen.length >= SAVED_USE_MAX;

  function toggle(key: string, on: boolean) {
    setLocal(null); setRefusal(null);
    setChosen((c) => (on ? (c.includes(key) || c.length >= SAVED_USE_MAX ? c : [...c, key]) : c.filter((k) => k !== key)));
  }

  function confirm() {
    setRefusal(null);
    const picked = chosen.map((k) => all.find((e) => e.key === k)).filter((e): e is PickEntry => !!e);
    const built = buildUseInPost(post, picked);
    if (!built.ok) { setLocal(built.message); return; }
    setLocal(null);
    start(async () => {
      const r = await savePostFields(post.id, post.pipelineStatus, built.body.fields, { ...(built.body.savedItemIds ? { savedItemIds: built.body.savedItemIds } : {}), actionId: actionId.current });
      if (r.ok) {
        onResult(r, picked.length === 1 ? "Used 1 saved item in the post" : `Used ${picked.length} saved items in the post`);
        onClose();
        return;
      }
      setRefusal({ refusal: r.refusal, text: useRefusalText(r.refusal) });
      // a refused edit is a new click next time (a fresh replay key), and a moved post is re-read by the page
      actionId.current = newActionId();
      if (r.refusal.error === "status_changed") onResult(r, "");
    });
  }

  return (
    <Modal
      open onClose={onClose} title="Use from Saved" size="lg"
      footer={
        <>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={confirm} disabled={pending || chosen.length === 0 || !author}>{pending ? "Adding…" : "Add to the post"}</button>
        </>
      }
    >
      <div className="scp-usepick">
        <p className="scp-field__hint" style={{ margin: 0 }}>
          {post.clientName}&apos;s content bank. Texts go into the caption, hashtag sets into the hashtags, links into the reference images. Choose 1 to {SAVED_USE_MAX}.
        </p>
        {loaded.state === "loading" && <p className="scp-note" role="status" style={{ margin: 0 }}>Reading the content bank…</p>}
        {loaded.state === "unknown" && <p className="scp-note" role="status" style={{ margin: 0 }}>The content bank could not be read, so nothing is shown. This is not a statement that it is empty.</p>}
        {loaded.state === "ready" && (
          <>
            <div className="scp-field">
              <label htmlFor={`${uid}-q`}>Search the content bank</label>
              <input id={`${uid}-q`} className="scp-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A word from the title, text or link" />
            </div>
            {all.length === 0 && <p className="scp-note" role="status" style={{ margin: 0 }}>This client has nothing saved yet.</p>}
            {all.length > 0 && shown.length === 0 && <p className="scp-note" role="status" style={{ margin: 0 }}>Nothing in the content bank matches &ldquo;{q.trim()}&rdquo;.</p>}
            {shown.map((g) => (
              <fieldset key={g.key} className="scp-usepick__group">
                <legend>{g.label}</legend>
                {g.more && <p className="scp-note" style={{ margin: "0 0 8px" }}>Only the newest items of this category are listed here. Search, or open the Saved page, to find older ones.</p>}
                <ul className="scp-usepick__list">
                  {g.entries.map((e) => {
                    const off = unusableWords(post, e);
                    const on = chosen.includes(e.key);
                    const id = `${uid}-${e.key.replace(/[^a-z0-9]/gi, "_")}`;
                    const blocked = off !== null || (full && !on);
                    return (
                      <li key={e.key}>
                        <label className={`scp-usepick__item${blocked ? " scp-usepick__item--off" : ""}`} htmlFor={id}>
                          <input id={id} type="checkbox" checked={on} disabled={blocked} onChange={(ev) => toggle(e.key, ev.target.checked)} aria-describedby={`${id}-d`} />
                          <span className="scp-usepick__body">
                            <span className="scp-usepick__title">{e.title}</span>
                            {e.versionId && (
                              // eslint-disable-next-line @next/next/no-img-element -- the Asset Library route streams the stored bytes; the title names it
                              <img className="scp-usepick__thumb" src={imageHref(e.versionId)} alt="" loading="lazy" decoding="async" />
                            )}
                            {preview(e) && <span className="scp-usepick__preview">{preview(e)}</span>}
                            <span className="scp-usepick__meta" id={`${id}-d`}>{entryMeta(e)}{off ? ` · ${off}` : full && !on ? ` · ${SAVED_USE_MAX} are chosen already.` : ` · ${goesWords(e)}`}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ))}
            <p className="scp-usepick__count" role="status">{chosenWords(chosen.length)}</p>
          </>
        )}
        {local && <p className="scp-msg scp-msg--error" role="alert" style={{ margin: 0 }}>{local}</p>}
        {refusal && <RefusalNote refusal={refusal.refusal} message={refusal.text} />}
      </div>
    </Modal>
  );
}

/** The button and its picker. Drawn only where the post's step takes the copy or the reference images and the viewer may author the post. */
export function UseFromSaved({ post, author, onResult }: { post: PipelinePost; author: boolean; onResult: (r: WriteResult, label: string) => void }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (!canUseFromSaved(post, author)) return null;
  // The modal returns focus to what was focused when it opened; some browsers do not focus a button on click, so the button takes it back itself.
  const close = () => { setOpen(false); opener.current?.focus(); };
  return (
    <div className="scp-row__buttons">
      <button ref={opener} type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)} aria-haspopup="dialog">Use from Saved</button>
      {open && <Picker post={post} author={author} onClose={close} onResult={onResult} />}
    </div>
  );
}
