"use client";
// SCP-1a — the brand book form of one client (BFF §63.1, §63.4). SELF-CONTAINED and reusable: the Allocation page opens it in a drawer from a
// client's row, and SCP-1k's Client profile tab renders it as the `brand` tab. It needs a `clientId` and nothing from the page around it.
//
// Reading: pass `initial` (a page that already holds the book), or leave it out and the form loads the client's book itself (`loadBrandBook`,
// `GET brand-profiles/:clientId`; a client with no profile yet starts empty, and the first save creates it).
// Writing: `PATCH brand-profiles/:clientId` needs `social_engagement` · `update`. `canEdit` is the page's hint of that (the server's 403 is the
// boundary, and its words are shown); without it every control is disabled and the reason is on the page.
//
// The form validates before it sends (`validateBrandBook`, a mirror of the server's rules) and names the first problem; the server re-checks
// everything and its 400 `{field}` comes back in words. Eight fields: the tone in one line, content pillars, must-have notes and brand rules (one
// per line), hashtag sets, channels, key dates and links. Saving sends the whole book; the server keeps the rest of the profile.
import { useEffect, useId, useState, useTransition } from "react";
import { loadBrandBook, saveBrandBook } from "@/lib/socialAllocationActions";
import { ALLOCATION_NETWORKS, NETWORK_LABEL } from "@/lib/socialAllocation";
import {
  BRAND_LIMITS, EMPTY_BRAND_BOOK, parseLines, parseTags, validateBrandBook,
  type BrandBook, type BrandChannel, type BrandLink, type KeyDate,
} from "@/lib/socialBrandBook";

export const BRAND_EDIT_REFUSAL_REASON = "Changing the brand book needs the Social Media manager role. You can read it here.";

interface Draft {
  toneSummary: string;
  pillars: string;
  notes: string;
  rules: string;
  sets: Array<{ name: string; tagsText: string }>;
  channels: BrandChannel[];
  keyDates: KeyDate[];
  links: BrandLink[];
}

const toDraft = (b: BrandBook): Draft => ({
  toneSummary: b.toneSummary,
  pillars: b.contentPillars.join("\n"),
  notes: b.mustHaveNotes.join("\n"),
  rules: b.brandRules.join("\n"),
  sets: b.hashtagSets.map((s) => ({ name: s.name, tagsText: s.tags.join(" ") })),
  channels: b.channels.map((c) => ({ ...c })),
  keyDates: b.keyDates.map((d) => ({ ...d })),
  links: b.links.map((l) => ({ ...l })),
});

const fromDraft = (d: Draft): BrandBook => ({
  toneSummary: d.toneSummary,
  contentPillars: parseLines(d.pillars),
  mustHaveNotes: parseLines(d.notes),
  brandRules: parseLines(d.rules),
  hashtagSets: d.sets.map((s) => ({ name: s.name, tags: parseTags(s.tagsText) })),
  channels: d.channels,
  keyDates: d.keyDates,
  links: d.links,
});

export function BrandBookForm({
  clientId, clientName, initial, canEdit, onSaved,
}: {
  clientId: string;
  clientName?: string;
  /** The book, when the page already holds it. Left out, the form loads it. */
  initial?: BrandBook;
  /** The page's hint that the caller may change the brand book; the server decides. */
  canEdit: boolean;
  onSaved?: (book: BrandBook) => void;
}) {
  const id = useId();
  const reasonId = `${id}-reason`;
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial ?? EMPTY_BRAND_BOOK));
  const [loaded, setLoaded] = useState<"loading" | "ready" | { error: string }>(initial ? "ready" : "loading");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string; field?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const locked = !canEdit;

  useEffect(() => {
    if (initial) return;
    let live = true;
    void loadBrandBook(clientId).then((res) => {
      if (!live) return;
      if (!res.ok) { setLoaded({ error: res.message }); return; }
      setDraft(toDraft(res.book));
      setLoaded("ready");
    });
    return () => { live = false; };
  }, [clientId, initial]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const patchRow = <K extends "sets" | "channels" | "keyDates" | "links">(k: K, i: number, change: Partial<Draft[K][number]>) =>
    setDraft((d) => ({ ...d, [k]: (d[k] as Array<Record<string, unknown>>).map((r, j) => (j === i ? { ...r, ...change } : r)) }));
  const dropRow = (k: "sets" | "channels" | "keyDates" | "links", i: number) =>
    setDraft((d) => ({ ...d, [k]: (d[k] as unknown[]).filter((_, j) => j !== i) }));

  function save() {
    setMsg(null);
    const book = fromDraft(draft);
    const checked = validateBrandBook(book);
    if (!checked.ok) { setMsg({ kind: "error", text: checked.message, field: checked.field }); return; }
    startTransition(async () => {
      const res = await saveBrandBook(clientId, checked.book);
      if (!res.ok) { setMsg({ kind: "error", text: res.message, field: res.field }); return; }
      setDraft(toDraft(res.book));
      setMsg({ kind: "ok", text: "Brand book saved." });
      onSaved?.(res.book);
    });
  }

  if (loaded === "loading") return <p className="scp-note" role="status">Loading the brand book…</p>;
  if (typeof loaded === "object") return <p className="scp-msg scp-msg--error" role="alert">The brand book could not be read: {loaded.error}</p>;

  const dis = locked || pending;
  const lim = BRAND_LIMITS;
  const describedBy = locked ? reasonId : undefined;

  return (
    <form className="scp-brand" onSubmit={(e) => { e.preventDefault(); if (!dis) save(); }} aria-label={clientName ? `Brand book of ${clientName}` : "Brand book"}>
      <label className="scp-field">
        Tone in one line
        <input
          className="scp-input scp-input--wide" type="text" value={draft.toneSummary}
          onChange={(e) => set("toneSummary", e.target.value)} disabled={dis} aria-describedby={describedBy}
        />
        <span className="scp-field__hint">At most {lim.toneSummary} characters.</span>
      </label>

      <label className="scp-field">
        Content pillars
        <textarea className="scp-input scp-input--wide scp-textarea" rows={4} value={draft.pillars} onChange={(e) => set("pillars", e.target.value)} disabled={dis} aria-describedby={describedBy} />
        <span className="scp-field__hint">One per line. Up to {lim.contentPillars.max}, each at most {lim.contentPillars.each} characters.</span>
      </label>

      <label className="scp-field">
        Must-have notes
        <textarea className="scp-input scp-input--wide scp-textarea" rows={4} value={draft.notes} onChange={(e) => set("notes", e.target.value)} disabled={dis} aria-describedby={describedBy} />
        <span className="scp-field__hint">What every post for this client must carry. One per line. Up to {lim.mustHaveNotes.max}, each at most {lim.mustHaveNotes.each} characters.</span>
      </label>

      <label className="scp-field">
        Brand rules
        <textarea className="scp-input scp-input--wide scp-textarea" rows={4} value={draft.rules} onChange={(e) => set("rules", e.target.value)} disabled={dis} aria-describedby={describedBy} />
        <span className="scp-field__hint">One per line. Up to {lim.brandRules.max}, each at most {lim.brandRules.each} characters.</span>
      </label>

      <fieldset className="scp-fieldset" disabled={dis}>
        <legend>Hashtag sets</legend>
        {draft.sets.map((s, i) => (
          <div className="scp-row" key={i}>
            <input className="scp-input" type="text" aria-label={`Hashtag set ${i + 1} name`} placeholder="Name" value={s.name} onChange={(e) => patchRow("sets", i, { name: e.target.value })} />
            <input className="scp-input scp-input--wide" type="text" aria-label={`Hashtag set ${i + 1} tags`} placeholder="Tags, separated by spaces (no #)" value={s.tagsText} onChange={(e) => patchRow("sets", i, { tagsText: e.target.value })} />
            <button type="button" className="scp-link" onClick={() => dropRow("sets", i)} aria-label={`Remove hashtag set ${i + 1}`}>Remove</button>
          </div>
        ))}
        <button type="button" className="scp-link" onClick={() => set("sets", [...draft.sets, { name: "", tagsText: "" }])} disabled={draft.sets.length >= lim.hashtagSets.max}>Add a hashtag set</button>
      </fieldset>

      <fieldset className="scp-fieldset" disabled={dis}>
        <legend>Channels</legend>
        {draft.channels.map((c, i) => (
          <div className="scp-row" key={i}>
            <select className="scp-input" aria-label={`Channel ${i + 1} network`} value={c.network} onChange={(e) => patchRow("channels", i, { network: e.target.value })}>
              <option value="">Network</option>
              {ALLOCATION_NETWORKS.map((n) => <option key={n} value={n}>{NETWORK_LABEL[n]}</option>)}
            </select>
            <input className="scp-input" type="text" aria-label={`Channel ${i + 1} handle`} placeholder="Handle" value={c.handle} onChange={(e) => patchRow("channels", i, { handle: e.target.value })} />
            <input className="scp-input scp-input--wide" type="url" aria-label={`Channel ${i + 1} link`} placeholder="https://" value={c.url ?? ""} onChange={(e) => patchRow("channels", i, { url: e.target.value })} />
            <button type="button" className="scp-link" onClick={() => dropRow("channels", i)} aria-label={`Remove channel ${i + 1}`}>Remove</button>
          </div>
        ))}
        <button type="button" className="scp-link" onClick={() => set("channels", [...draft.channels, { network: "", handle: "" }])} disabled={draft.channels.length >= lim.channels.max}>Add a channel</button>
      </fieldset>

      <fieldset className="scp-fieldset" disabled={dis}>
        <legend>Key dates</legend>
        {draft.keyDates.map((d, i) => (
          <div className="scp-row" key={i}>
            <input className="scp-input" type="text" aria-label={`Key date ${i + 1} day`} placeholder="MM-DD or YYYY-MM-DD" value={d.date} onChange={(e) => patchRow("keyDates", i, { date: e.target.value })} />
            <input className="scp-input scp-input--wide" type="text" aria-label={`Key date ${i + 1} label`} placeholder="What happens" value={d.label} onChange={(e) => patchRow("keyDates", i, { label: e.target.value })} />
            <button type="button" className="scp-link" onClick={() => dropRow("keyDates", i)} aria-label={`Remove key date ${i + 1}`}>Remove</button>
          </div>
        ))}
        <button type="button" className="scp-link" onClick={() => set("keyDates", [...draft.keyDates, { date: "", label: "" }])} disabled={draft.keyDates.length >= lim.keyDates.max}>Add a key date</button>
      </fieldset>

      <fieldset className="scp-fieldset" disabled={dis}>
        <legend>Links</legend>
        {draft.links.map((l, i) => (
          <div className="scp-row" key={i}>
            <input className="scp-input" type="text" aria-label={`Link ${i + 1} label`} placeholder="Label" value={l.label} onChange={(e) => patchRow("links", i, { label: e.target.value })} />
            <input className="scp-input scp-input--wide" type="url" aria-label={`Link ${i + 1} address`} placeholder="https://" value={l.url} onChange={(e) => patchRow("links", i, { url: e.target.value })} />
            <button type="button" className="scp-link" onClick={() => dropRow("links", i)} aria-label={`Remove link ${i + 1}`}>Remove</button>
          </div>
        ))}
        <button type="button" className="scp-link" onClick={() => set("links", [...draft.links, { label: "", url: "" }])} disabled={draft.links.length >= lim.links.max}>Add a link</button>
      </fieldset>

      <div className="scp-actions">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={dis} title={locked ? BRAND_EDIT_REFUSAL_REASON : undefined} aria-describedby={describedBy}>
          {pending ? "Saving…" : "Save brand book"}
        </button>
      </div>
      {locked && <p className="scp-note scp-note--reason" id={reasonId}>{BRAND_EDIT_REFUSAL_REASON}</p>}
      {msg && <p className={`scp-msg scp-msg--${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</p>}
    </form>
  );
}
