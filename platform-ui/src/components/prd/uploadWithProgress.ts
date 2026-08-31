// Browser-side file upload with progress. Client-safe, no React.
//
// Why not a server action: Server Actions buffer the whole body on the Next server and cap it
// (1 MB by default; `next.config.ts` raises it for the paths that still use one), and they give the
// browser no progress events — a 200 MB video upload looks hung for minutes. XMLHttpRequest is the
// one browser API that reports upload progress, so the file goes straight to the BFF route
// (`app/api/meetings/[id]/audio`), which streams it on to the platform without holding it in memory.

export interface UploadProgress { fraction: number; loaded: number; total: number }
export type UploadOutcome = { ok: true } | { ok: false; status: number; error: string };

export function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
  Xhr: typeof XMLHttpRequest = XMLHttpRequest,
): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const xhr = new Xhr();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      onProgress({ fraction: e.total > 0 ? e.loaded / e.total : 0, loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
      let error = `Upload failed (${xhr.status}).`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string };
        if (body.error) error = body.error;
      } catch { /* not JSON — keep the plain sentence */ }
      resolve({ ok: false, status: xhr.status, error });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, error: "Upload failed — the connection dropped. Check your network and try again." });
    xhr.onabort = () => resolve({ ok: false, status: 0, error: "Upload cancelled." });
    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/** The PRD Studio default: upload into an existing recording through the BFF streaming route. */
export function uploadRecordingFile(recordingId: string, file: File, onProgress: (p: UploadProgress) => void): Promise<UploadOutcome> {
  return uploadWithProgress(`/api/meetings/${encodeURIComponent(recordingId)}/audio`, file, onProgress);
}

export function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
}
