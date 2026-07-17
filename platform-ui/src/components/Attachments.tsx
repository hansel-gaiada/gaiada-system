"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FileMeta } from "@/lib/entities";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDate } from "@/lib/format";

interface Props {
  files: (FileMeta & { url?: string | null })[];
  canEdit: boolean;
  attach: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
  remove: (fileId: string) => Promise<{ ok: boolean; error?: string }>;
}

// File references on an entity (name + optional link). Binary/multipart upload
// is a documented backend follow-up; this attaches references today.
export function Attachments({ files, canEdit, attach, remove }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => { const r = await fn(); setMsg(r.ok ? null : r.error ?? "Failed."); if (r.ok) setOpen(false); router.refresh(); });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {files.length === 0 ? <EmptyNote>No attachments.</EmptyNote> : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {files.map((f) => (
            <div key={f.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "0.5px solid var(--erp-hairline-soft)" }}>
              <span style={{ minWidth: 0 }}>
                {f.url ? <a href={f.url} target="_blank" rel="noreferrer" style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>{f.filename}</a>
                  : <span style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>{f.filename}</span>}
                <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", marginLeft: 8 }}>{formatDate(f.created_at)}</span>
              </span>
              {canEdit && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => run(() => remove(f.id))}>Remove</button>}
            </div>
          ))}
        </div>
      )}
      {canEdit && (open ? (
        <form action={(fd) => run(() => attach(fd))} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <input name="filename" placeholder="File name" required className="lux-field__control" style={{ flex: "1 1 160px" }} />
          <input name="url" placeholder="Link (optional)" className="lux-field__control" style={{ flex: "1 1 160px" }} />
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>Attach</button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>Attach file</button>
      ))}
      {msg && <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
    </div>
  );
}
