"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { mintUploadTokenAction } from "@/lib/webdeskMediaActions";
import type { SiteScope } from "@/lib/webdeskContentActions";
import type { WdResult } from "@/lib/webdeskContentModel";
import { uploadFile } from "@/lib/mediaUpload";
import {
  bucketFor, checkFileAgainstToken, failureFromMint, isUploadDenial, originOf,
  type MediaAsset, type UploadFailure, type UploadToken,
} from "@/lib/webdeskMediaModel";

// The upload queue of the media library. One row per file; each file asks the BFF for its OWN token (a token is single-use and
// is spent even by a refused body), then sends the raw bytes straight to WebDesk (`lib/mediaUpload.ts`). Files go one at a
// time, so a batch never trips WebDesk's per-tenant concurrent-upload slots (it answers 503 "busy" beyond them).
//
// A RETRY is a brand-new attempt: it mints a fresh token, never re-POSTs to the old URL.
//
// Progress is shown by each row's <progress>; what is ANNOUNCED (`announcement`, one polite status line) is only the
// milestones: started, halfway, done, failed. Per-percent announcements would be live-region spam.

export type UploadState = "queued" | "minting" | "uploading" | "done" | "failed";

export interface UploadRow {
  id: string;
  file: File;
  state: UploadState;
  /** 0..1 */
  progress: number;
  failure: UploadFailure | null;
  asset: MediaAsset | null;
}

export interface UseMediaUploads {
  rows: UploadRow[];
  announcement: string;
  enqueue: (files: File[]) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  /** True while anything is queued, minting or uploading. */
  active: boolean;
}

let seq = 0;

export function useMediaUploads(opts: {
  scope: SiteScope;
  /** A finished upload: the library adds it to the grid (and, in the picker, selects it). */
  onUploaded: (asset: MediaAsset) => void;
  /** The BFF said this caller may not upload: the library turns Upload off with the reason. */
  onDenied: (failure: UploadFailure) => void;
  /** The origin WebDesk serves media from, learned from a minted upload URL (origin only; the token never leaves this hook). */
  onOrigin?: (origin: string) => void;
  /** WSK-49d: the portal's token mint (client mode). Absent = the staff action, as before. */
  mint?: (scope: SiteScope, bucket: "media" | "video") => Promise<WdResult<UploadToken>>;
}): UseMediaUploads {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const rowsRef = useRef<UploadRow[]>([]);
  const busy = useRef(false);
  const mounted = useRef(true);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const commit = (next: UploadRow[]) => { rowsRef.current = next; if (mounted.current) setRows(next); };
  const patch = (id: string, p: Partial<UploadRow>) => commit(rowsRef.current.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const say = (s: string) => { if (mounted.current) setAnnouncement(s); };

  const run = async (row: UploadRow) => {
    const { file, id } = row;
    const failWith = (f: UploadFailure) => {
      patch(id, { state: "failed", failure: f, progress: 0 });
      say(`${file.name} wasn't uploaded. ${f.title}`);
      if (isUploadDenial(f)) optsRef.current.onDenied(f);
    };
    patch(id, { state: "minting", failure: null, progress: 0 });
    const minted = await (optsRef.current.mint ?? mintUploadTokenAction)(optsRef.current.scope, bucketFor(file.type));
    if (minted.kind !== "ok") { failWith(failureFromMint(minted)); return; }
    const token = minted.data;
    const origin = originOf(token.uploadUrl);
    if (origin) optsRef.current.onOrigin?.(origin);
    const refused = checkFileAgainstToken(file, token);
    if (refused) { failWith(refused); return; }
    patch(id, { state: "uploading" });
    say(`Uploading ${file.name}.`);
    let half = false;
    const out = await uploadFile(token.uploadUrl, file, {
      maxBytes: token.maxBytes,
      onProgress: (f) => {
        patch(id, { progress: f });
        if (!half && f >= 0.5 && f < 1) { half = true; say(`${file.name} is half uploaded.`); }
      },
    });
    if (!out.ok) { failWith(out.failure); return; }
    patch(id, { state: "done", progress: 1, asset: out.asset, failure: null });
    say(`${file.name} uploaded.`);
    optsRef.current.onUploaded(out.asset);
  };

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (;;) {
        const next = rowsRef.current.find((r) => r.state === "queued");
        if (!next) break;
        await run(next);
      }
    } finally {
      busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enqueue = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const added: UploadRow[] = files.map((file) => ({ id: `u${++seq}`, file, state: "queued", progress: 0, failure: null, asset: null }));
    commit([...rowsRef.current, ...added]);
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pump]);

  const retry = useCallback((id: string) => {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row || row.state !== "failed") return;
    patch(id, { state: "queued", failure: null, progress: 0 });
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pump]);

  const dismiss = useCallback((id: string) => {
    commit(rowsRef.current.filter((r) => r.id !== id || r.state === "minting" || r.state === "uploading"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { rows, announcement, enqueue, retry, dismiss, active: rows.some((r) => r.state === "queued" || r.state === "minting" || r.state === "uploading") };
}
