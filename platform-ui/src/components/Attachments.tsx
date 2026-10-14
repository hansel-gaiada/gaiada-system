"use client";
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { FileMeta } from "@/lib/entities";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDate } from "@/lib/format";
import { isDriveUrl } from "@/lib/drive";
import { DrivePicker } from "@/components/drive/DrivePicker";
import { FILE_TOO_BIG, MAX_UPLOAD_BYTES, SCRUBBED_NOTICE, formatFileSize } from "@/lib/fileUpload";

type ActionResult = { ok: boolean; error?: string; scrubbed?: boolean };

interface Props {
  files: (FileMeta & { url?: string | null })[];
  canEdit: boolean;
  /** DW-6i: the person is connected to Google Drive and it is configured (the Picker read said so). Offers "Attach from Google Drive". */
  canAttachFromDrive?: boolean;
  /** The task the Drive picker attaches to; required with `canAttachFromDrive`. */
  driveTaskId?: string;
  attach: (formData: FormData) => Promise<ActionResult>;
  remove: (fileId: string) => Promise<ActionResult>;
  /** DW-8h: a real upload (the form carries a `file`). Absent: no upload control is drawn (the task page keeps its references only). */
  upload?: (formData: FormData) => Promise<ActionResult>;
}

// Files on an entity: references (name + optional link) and, with `upload`, real files (DW-8h, contract §45.2). An uploaded
// file (no `url`) downloads through `/api/files/:id`, which forces an attachment.
export function Attachments({ files, canEdit, canAttachFromDrive = false, driveTaskId, attach, remove, upload }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<ActionResult>) =>
    startTransition(async () => {
      const r = await fn();
      setMsg(r.ok ? (r.scrubbed ? SCRUBBED_NOTICE : null) : r.error ?? "Failed.");
      if (r.ok) setOpen(false);
      router.refresh();
    });
  // The 25 MB limit is checked here too, so a huge file is never read into a request; the action checks again.
  const submitUpload = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!upload) return;
    const f = (e.currentTarget.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
    if (!f || f.size === 0) return setMsg("Choose a file to upload.");
    if (f.size > MAX_UPLOAD_BYTES) return setMsg(FILE_TOO_BIG);
    const fd = new FormData();
    fd.set("file", f);
    run(() => upload(fd));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {files.length === 0 ? <EmptyNote>No attachments.</EmptyNote> : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {files.map((f) => (
            <div key={f.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "0.5px solid var(--erp-hairline-soft)" }}>
              <span style={{ minWidth: 0 }}>
                {f.url ? (
                  <>
                    {isDriveUrl(f.url) && <span className="drive-mark" title="Google Drive" aria-label="Google Drive" role="img" style={{ marginRight: 6, font: "600 11px var(--font-body)", color: "var(--erp-ink-50)" }}>&#9650;</span>}
                    <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>{f.filename}</a>
                  </>
                ) : (
                  <a href={`/api/files/${encodeURIComponent(f.id)}`} download style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }} aria-label={`Download ${f.filename}`}>{f.filename}</a>
                )}
                <span style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", marginLeft: 8 }}>
                  {f.byte_size > 0 ? `${formatFileSize(f.byte_size)} · ` : ""}{formatDate(f.created_at)}
                </span>
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
      {canEdit && upload && (
        <form onSubmit={submitUpload} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="file" name="file" aria-label="File to upload" className="lux-field__control" style={{ flex: "1 1 200px" }} disabled={pending} />
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}>Upload</button>
        </form>
      )}
      {canEdit && canAttachFromDrive && driveTaskId && <DrivePicker taskId={driveTaskId} />}
      {msg && <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
    </div>
  );
}
