"use client";
// SCP-1e, 1h (BFF §63.6.6) — the designer's part of the post page: the designs of the post (an Asset Library version, or a link with its source and AI note), and
// the controls to add one and remove one. Start design and Submit for the final check are actions in the bar (`start_design`, `submit_design`).
//
// Who may touch them is the read's: the viewer must be the post's designer (`canDesignPost`: the read lists a `design` action as allowed) and the post must be with
// the designer (its holder), which is a design step or a design change. The server decides on the write. An asset is added by its version group, chosen from the
// Asset Library the page read; a link needs its source, and an AI-made one its note (the database refuses one without). A link has nothing to show the client:
// the final check refuses it (409 `design_not_stored`), and the row says so.
import { useId, useState, useTransition } from "react";
import { RefusalNote } from "@/components/social/PostRefusal";
import { SOURCE_LABEL, SOURCES, canDesignPost, isHttpUrl, type AssetChoice, type PipelinePost } from "@/lib/socialPipeline";
import { addPostDesign, removePostDesign, type WriteResult } from "@/lib/socialPipelineActions";

type Failed = Extract<WriteResult, { ok: false }>;

const STATE_LABEL: Record<string, string> = { not_started: "Not started", in_progress: "In progress", submitted: "Submitted", revision: "Revision asked" };

export function PostDesigns({ post, assets, onResult }: { post: PipelinePost; assets: AssetChoice[] | null; onResult: (r: WriteResult, label: string) => void }) {
  const uid = useId();
  const canEdit = canDesignPost(post) && post.holder.role === "designer";
  const designs = [...post.designs].sort((a, b) => a.position - b.position);
  const [mode, setMode] = useState<"asset" | "link">(assets && assets.length > 0 ? "asset" : "link");
  const [groupId, setGroupId] = useState("");
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("own");
  const [aiNote, setAiNote] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const [error, setError] = useState<Failed | null>(null);
  const [pending, start] = useTransition();

  function add() {
    setError(null);
    if (mode === "asset") {
      if (!groupId) { setLocal("Choose an asset first."); return; }
    } else {
      if (!isHttpUrl(url.trim())) { setLocal("The link must start with http:// or https://."); return; }
      if (source === "ai" && aiNote.trim() === "") { setLocal("A design made with AI needs a note on how."); return; }
    }
    setLocal(null);
    start(async () => {
      const r = await addPostDesign(post.id, post.pipelineStatus, mode === "asset"
        ? { assetGroupId: groupId }
        : { linkUrl: url.trim(), linkSource: source, ...(source === "ai" ? { linkAiNote: aiNote.trim() } : {}) });
      onResult(r, "Design added");
      if (r.ok) { setGroupId(""); setUrl(""); setAiNote(""); setSource("own"); } else setError(r);
    });
  }
  function remove(id: string) {
    setError(null);
    start(async () => {
      const r = await removePostDesign(post.id, id);
      onResult(r, "Design removed");
      if (!r.ok) setError(r);
    });
  }

  return (
    <section aria-labelledby={`${uid}-h`}>
      <h3 className="scp-post__section-title" id={`${uid}-h`}>Designs</h3>
      {post.creativeSource && (
        <p className="scp-field__hint" style={{ margin: "0 0 6px" }}>
          {post.creativeSource === "creatives" ? "Made by the Creatives team" : "Made by the team's own designer"}
          {post.creativeState ? ` · ${STATE_LABEL[post.creativeState] ?? post.creativeState}` : ""}
        </p>
      )}
      {designs.length === 0 ? (
        <p className="scp-note" style={{ margin: 0 }}>No design yet.</p>
      ) : (
        <ul className="scp-designs">
          {designs.map((d) => {
            const src = d.asset?.source ?? d.link?.source ?? "unknown";
            const note = d.asset?.aiNote ?? d.link?.aiNote ?? null;
            return (
              <li key={d.id} className="scp-design">
                <span className="scp-design__name">
                  {d.asset ? `${d.asset.name} · version ${d.asset.versionNo}` : d.link ? <a href={d.link.url} target="_blank" rel="noopener noreferrer">{d.link.url}</a> : "Design"}
                </span>
                <span className="scp-design__sub">
                  Source: {SOURCE_LABEL[src] ?? src}{note ? ` · AI note: ${note}` : ""}
                  {d.fileId ? " · Stored for the client" : d.asset ? "" : " · A link only: it cannot go to the client"}
                </span>
                {canEdit && <button type="button" className="scp-link" disabled={pending} onClick={() => remove(d.id)} aria-label={`Remove design ${d.position}`}>Remove</button>}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <div className="scp-dialog" style={{ marginTop: 10 }}>
          <fieldset className="scp-checks" aria-label="Add a design">
            <label><input type="radio" name={`${uid}-mode`} checked={mode === "asset"} onChange={() => { setMode("asset"); setLocal(null); }} /> From the Asset Library</label>
            <label><input type="radio" name={`${uid}-mode`} checked={mode === "link"} onChange={() => { setMode("link"); setLocal(null); }} /> A link</label>
          </fieldset>
          {mode === "asset" ? (
            assets === null ? (
              <p className="scp-note" style={{ margin: 0 }}>The Asset Library could not be read, so add the design as a link for now.</p>
            ) : assets.length === 0 ? (
              <p className="scp-note" style={{ margin: 0 }}>The Asset Library has no saved assets yet. Save the design there, or add it as a link.</p>
            ) : (
              <label className="scp-field">
                Asset
                <select className="scp-input" value={groupId} onChange={(e) => { setGroupId(e.target.value); setLocal(null); }}>
                  <option value="">Choose…</option>
                  {assets.map((a) => <option key={a.groupId} value={a.groupId}>{`${a.name} (version ${a.versionNo})`}</option>)}
                </select>
              </label>
            )
          ) : (
            <>
              <label className="scp-field">
                Link
                <input className="scp-input" type="url" placeholder="https://" value={url} onChange={(e) => { setUrl(e.target.value); setLocal(null); }} />
              </label>
              <label className="scp-field">
                Where it came from
                <select className="scp-input" value={source} onChange={(e) => { setSource(e.target.value); setLocal(null); }}>
                  {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                </select>
              </label>
              {source === "ai" && (
                <label className="scp-field">
                  How it was made with AI
                  <input className="scp-input" type="text" value={aiNote} maxLength={1000} onChange={(e) => { setAiNote(e.target.value); setLocal(null); }} />
                </label>
              )}
            </>
          )}
          <div className="scp-row__buttons">
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || (mode === "asset" && (assets === null || assets.length === 0))} onClick={add}>{pending ? "Adding…" : "Add design"}</button>
          </div>
        </div>
      )}
      {local && <p className="scp-msg scp-msg--error" role="alert">{local}</p>}
      {error && <RefusalNote refusal={error.refusal} message={error.message} />}
    </section>
  );
}
