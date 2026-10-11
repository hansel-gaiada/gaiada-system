// WSK-43c — the browser half of an upload: the raw file goes STRAIGHT to WebDesk's public `uploadUrl`; the bytes never
// pass through the ERP. BROWSER-ONLY (XMLHttpRequest, for upload progress, which `fetch` cannot report), and imported only
// by the media components: it is deliberately not one of the four modules platform-nest's contract test loads.
//
//   POST <uploadUrl>?filename=<name>      Content-Type: <the file's own type>      body: the raw file
//   201 -> the asset (with its canonical `url`)          anything else -> `failureFromUploadResponse`
//
// The token inside `uploadUrl` is single-use and is spent even by a refused body, so a RETRY is never a second POST to the
// same URL: the caller asks the BFF for a fresh token first (`mintUploadTokenAction`). No credentials and no custom
// headers are sent (WebDesk's CORS preflight allows `content-type` and `x-request-id` only).
import {
  failureFromUploadResponse, parseUploadedAsset, MediaShapeError,
  type MediaAsset, type UploadFailure,
} from "./webdeskMediaModel";

export type UploadOutcome = { ok: true; asset: MediaAsset } | { ok: false; failure: UploadFailure };

export interface UploadOptions {
  /** Called with 0..1 as bytes leave the browser. */
  onProgress?: (fraction: number) => void;
  /** The token's size cap, for the "too large" words. */
  maxBytes?: number;
  signal?: AbortSignal;
}

/** `<uploadUrl>?filename=<name>`; the URL may already carry a query. The result is handed to XHR and never logged. */
export function withFilename(uploadUrl: string, filename: string): string {
  const u = new URL(uploadUrl);
  u.searchParams.set("filename", filename);
  return u.toString();
}

export function uploadFile(uploadUrl: string, file: File, opts: UploadOptions = {}): Promise<UploadOutcome> {
  return new Promise<UploadOutcome>((resolve) => {
    let target: string;
    try {
      target = withFilename(uploadUrl, file.name);
    } catch {
      resolve({ ok: false, failure: { kind: "failed", title: "WebDesk gave an upload address the browser can't use.", detail: "Nothing was uploaded." } });
      return;
    }
    const xhr = new XMLHttpRequest();
    const online = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);
    const fail = (status: number, body: unknown) => resolve({ ok: false, failure: failureFromUploadResponse(status, body, { maxBytes: opts.maxBytes, online: online() }) });

    xhr.open("POST", target, true);
    xhr.responseType = "text";
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);
    xhr.withCredentials = false;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total)); };
    xhr.onerror = () => fail(0, null);
    xhr.ontimeout = () => fail(408, null);
    xhr.onabort = () => resolve({ ok: false, failure: { kind: "failed", title: "The upload was cancelled.", detail: "Nothing was added." } });
    xhr.onload = () => {
      let body: unknown = null;
      try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { body = null; }
      if (xhr.status === 201) {
        try {
          opts.onProgress?.(1);
          resolve({ ok: true, asset: parseUploadedAsset(body) });
        } catch (e) {
          // WebDesk said 201 but not with an asset: the upload may well have landed, so never say "failed" and never invent an asset.
          const detail = e instanceof MediaShapeError ? e.message : "unexpected response";
          resolve({ ok: false, failure: { kind: "drift", title: "WebDesk accepted the file but answered with something unexpected.", detail: `Reload the library to see whether it was added. (${detail})` } });
        }
        return;
      }
      fail(xhr.status, body);
    };
    if (opts.signal) {
      if (opts.signal.aborted) { resolve({ ok: false, failure: { kind: "failed", title: "The upload was cancelled.", detail: "Nothing was added." } }); return; }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}
