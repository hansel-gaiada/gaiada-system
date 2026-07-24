"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectDoc, Template } from "@/lib/pm";
import { listDocTemplates, createDocTemplate } from "@/lib/pmActions";
import { Eyebrow } from "@/components/ui";
import { DocHistory } from "./DocHistory";
import "@/components/forms/forms.css";

interface Props {
  doc?: ProjectDoc | null;
  save: (title: string, body: string, docId?: string) => Promise<{ ok: boolean; error?: string }>;
}

// Lightweight project-doc editor (markdown-ish plain text). New doc when `doc`
// is absent; edit-in-place otherwise. P3-11 adds: note templates (new-doc mode),
// "Save as template", and a per-doc version History panel (edit mode) — the
// version list itself lives in the sibling DocHistory.tsx.
export function DocEditor({ doc, save }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [title, setTitle] = useState(doc?.title ?? "");
  const [body, setBody] = useState(doc?.body ?? "");
  const [pending, startTransition] = useTransition();

  // Note templates (kind:"doc") — new-doc mode only, same client-fetch
  // pattern NewTaskForm already uses for task templates.
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [tplMsg, setTplMsg] = useState<string | null>(null);
  useEffect(() => {
    if (open && !doc) listDocTemplates().then((r) => { if (r.ok) setTemplates(r.templates); });
  }, [open, doc]);

  function applyTemplate(id: string) {
    setSelectedTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    setTitle(tpl?.title ?? "");
    setBody(tpl?.body ?? "");
  }
  function saveAsTemplate() {
    const t = title.trim();
    if (!t) return;
    startTransition(async () => {
      const r = await createDocTemplate({ title: t, body });
      if (r.ok) {
        setTplMsg("Saved as template.");
        listDocTemplates().then((rr) => { if (rr.ok) setTemplates(rr.templates); });
      } else setTplMsg(r.error ?? "Couldn't save template.");
    });
  }

  if (historyOpen && doc) {
    return <DocHistory docId={doc.id} onBack={() => setHistoryOpen(false)} onRestored={() => router.refresh()} />;
  }

  if (!open) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {doc && <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>v{doc.version}</Eyebrow>}
        {doc && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setHistoryOpen(true)}>
            History ({doc.version})
          </button>
        )}
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>
          {doc ? "Edit doc" : "New doc"}
        </button>
      </div>
    );
  }

  return (
    <form
      action={() => {
        const t = title.trim();
        if (!t) return;
        startTransition(async () => { await save(t, body, doc?.id); setOpen(false); router.refresh(); });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      {!doc && (
        <label className="lux-field">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Template</Eyebrow>
          <select className="lux-field__control" value={selectedTemplateId} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">None</option>
            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.title}</option>)}
          </select>
        </label>
      )}
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Title</Eyebrow>
        <input className="lux-field__control" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Body</Eyebrow>
        <textarea className="lux-field__control lux-field__control--textarea" style={{ minHeight: 160 }} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {tplMsg && <p role="status" style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{tplMsg}</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !title.trim()}>{pending ? "Saving…" : "Save doc"}</button>
        {!doc && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={saveAsTemplate} disabled={pending || !title.trim()}>
            Save as template
          </button>
        )}
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}
