"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectDoc } from "@/lib/pm";
import { Eyebrow } from "@/components/ui";
import "@/components/forms/forms.css";

interface Props {
  doc?: ProjectDoc | null;
  save: (title: string, body: string, docId?: string) => Promise<{ ok: boolean; error?: string }>;
}

// Lightweight project-doc editor (markdown-ish plain text). New doc when `doc`
// is absent; edit-in-place otherwise.
export function DocEditor({ doc, save }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(doc?.title ?? "");
  const [body, setBody] = useState(doc?.body ?? "");
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>
        {doc ? "Edit doc" : "New doc"}
      </button>
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
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Title</Eyebrow>
        <input className="lux-field__control" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Body</Eyebrow>
        <textarea className="lux-field__control lux-field__control--textarea" style={{ minHeight: 160 }} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !title.trim()}>{pending ? "Saving…" : "Save doc"}</button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}
