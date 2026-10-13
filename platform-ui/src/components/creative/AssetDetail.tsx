"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReadResult } from "@/lib/readResult";
import { StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { IDENTITY_GRADE } from "@/lib/imaging";
import { saveCreativeAsset } from "@/lib/creativeActions";
import { requestReview, decideReview, withdrawReview } from "@/lib/creativeReviewActions";
import {
  assetContentHref, openRoundOf, reviewChip, roundStatusLabel, visibleActions,
  type AssetVersion, type ReviewRound,
} from "@/lib/creativeReviews";
import "./creative.css";

// DW-6h UI (contract §35.6): the asset detail's three lists and its actions. The lists render a ReadResult, so a refused or
// failed read says so and never reads as an empty list. The server stays the authority on every action; a refusal comes
// back as plain words and is shown quietly.

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Version history, newest first (the reader already answers newest first; sorted here too so the list never depends on it). */
export function VersionHistory({ result, currentId, meId }: { result: ReadResult<AssetVersion[]>; currentId: string; meId: string | null }) {
  if (result.kind !== "ok") {
    return <ReadRefusal subject="the version history" kind={result.kind} reason={result.kind === "unavailable" ? result.reason : undefined} inline />;
  }
  if (result.data.length === 0) return <EmptyNote>No versions yet.</EmptyNote>;
  const rows = [...result.data].sort((a, b) => b.versionNo - a.versionNo);
  return (
    <ol className="cs-vlist" aria-label="Version history">
      {rows.map((v) => (
        <li key={v.id} className="cs-vrow">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="cs-vrow__thumb" src={assetContentHref(v.id)} alt={`Version ${v.versionNo} of ${v.name}`} loading="lazy" />
          <span className="cs-vrow__meta">
            <span>
              <strong>v{v.versionNo}</strong>
              {v.isLatest ? " (latest)" : ""}
              {v.id === currentId ? " (shown)" : ""}
            </span>
            <span>{v.uploader_id && v.uploader_id === meId ? "Uploaded by you" : "Uploaded"} {when(v.created_at)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Review rounds, newest first. */
export function ReviewRounds({ result }: { result: ReadResult<ReviewRound[]> }) {
  if (result.kind !== "ok") {
    return <ReadRefusal subject="the review rounds" kind={result.kind} reason={result.kind === "unavailable" ? result.reason : undefined} inline />;
  }
  if (result.data.length === 0) return <EmptyNote>No review rounds yet.</EmptyNote>;
  const rows = [...result.data].sort((a, b) => b.round - a.round);
  return (
    <ol className="cs-rlist" aria-label="Review rounds">
      {rows.map((r) => (
        <li key={r.id} className="cs-rrow">
          <span className="cs-rrow__head">
            <strong>Round {r.round}</strong>
            {reviewChip({ status: r.status }) ? <StatusBadge label={reviewChip({ status: r.status })!.label} /> : <span>{roundStatusLabel(r.status)}</span>}
            <span>on v{r.versionNo}</span>
          </span>
          <span>Requested by {r.requestedByName ?? "someone"}, {when(r.requestedAt)}</span>
          {r.note ? <p className="cs-rrow__quote">Note: {r.note}</p> : null}
          {r.decidedAt ? <span>Decided by {r.decidedByName ?? "someone"}, {when(r.decidedAt)}</span> : null}
          {r.decisionComment ? <p className="cs-rrow__quote">Comment: {r.decisionComment}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/** The actions, each shown only when it can work. `latest` is the group's latest version (null when the history could not
 *  be read; the asset can then only be left alone). */
export function AssetActions({
  deptId, latest, current, rounds, meId,
}: {
  deptId: string;
  latest: AssetVersion | null;
  current: AssetVersion | null;
  rounds: ReadResult<ReviewRound[]>;
  meId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<"request" | "changes" | null>(null);
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const open = rounds.kind === "ok" ? openRoundOf(rounds.data) : null;
  const vis = visibleActions({
    isLatest: !!current && current.isLatest,
    openRound: rounds.kind === "ok" ? open : "unknown",
    meId,
  });
  if (!latest || !current) return null;

  const done = (r: { ok: boolean; error?: string }, ok: string) => {
    setMsg(r.ok ? ok : r.error ?? "That didn't work. Try again.");
    if (r.ok) { setForm(null); setText(""); router.refresh(); }
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    setMsg(null);
    start(async () => {
      try {
        const graded = await blobToBase64(file);
        const r = await saveCreativeAsset({
          name: file.name,
          presetId: "custom",
          grade: IDENTITY_GRADE as unknown as Record<string, number>,
          graded,
          contentType: file.type || "image/webp",
          versionOf: latest.id,
        });
        done(r, `Saved as version ${r.versionNo ?? ""}`.trim() + ".");
        if (r.ok && r.id) router.push(`/departments/${encodeURIComponent(deptId)}/assets/${encodeURIComponent(r.id)}`);
      } catch {
        setMsg("That file couldn't be read.");
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    });
  };

  const submit = () => {
    setMsg(null);
    if (form === "request") {
      start(async () => done(await requestReview(latest.id, text), "Review requested."));
    } else if (form === "changes" && open) {
      if (!text.trim()) { setMsg("Add a comment explaining what needs to change."); return; }
      start(async () => done(await decideReview(current.id, open.round, "changes_requested", text), "Changes requested."));
    }
  };

  return (
    <div className="cs-detail__actions-wrap">
      <div className="cs-detail__actions">
        {vis.uploadVersion && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => upload(e.target.files?.[0])}
              aria-label="Upload new version"
            />
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={() => fileRef.current?.click()}>
              Upload new version
            </button>
            <a className="lux-btn lux-btn--ghost lux-btn--sm" href={`/departments/${encodeURIComponent(deptId)}/studio?versionOf=${encodeURIComponent(latest.id)}`}>
              Edit in Image Studio
            </a>
          </>
        )}
        {vis.requestReview && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => { setForm("request"); setText(""); setMsg(null); }}>
            Request review
          </button>
        )}
        {vis.approve && open && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            onClick={() => { setMsg(null); start(async () => done(await decideReview(current.id, open.round, "approved"), "Approved.")); }}>
            Approve
          </button>
        )}
        {vis.requestChanges && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => { setForm("changes"); setText(""); setMsg(null); }}>
            Request changes
          </button>
        )}
        {vis.withdraw && open && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            onClick={() => { setMsg(null); start(async () => done(await withdrawReview(current.id, open.round), "Review withdrawn.")); }}>
            Withdraw
          </button>
        )}
      </div>
      {form && (
        <div className="cs-detail__form">
          <label className="lux-field__label" htmlFor="cs-review-text">{form === "request" ? "Note for the reviewer (optional)" : "What needs to change (required)"}</label>
          <textarea id="cs-review-text" className="lux-field__control lux-field__control--textarea" value={text} maxLength={form === "request" ? 2000 : 4000} onChange={(e) => setText(e.target.value)} />
          <div className="cs-detail__actions">
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || (form === "changes" && !text.trim())} onClick={submit}>
              {pending ? "Sending…" : form === "request" ? "Send for review" : "Send changes"}
            </button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => { setForm(null); setText(""); }}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className="cs-detail__msg" role="status">{msg}</p>}
    </div>
  );
}

/** The header chip for the group's latest round (nothing when there is none worth showing). */
export function ReviewChip({ review }: { review: { status: string } | null | undefined }) {
  const chip = reviewChip(review);
  return chip ? <StatusBadge label={chip.label} /> : null;
}
