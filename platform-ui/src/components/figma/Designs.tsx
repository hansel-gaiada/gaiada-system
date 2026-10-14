"use client";
// DW-6k UI — the Designs section (docs/FRONTEND-BFF-CONTRACT.md §36.6). It sits on the PM task page, the request page and a
// campaign part, and shows the Figma files and frames linked to that work: a thumbnail, the title, when it last changed, its open
// comments, "Open in Figma", Export into the Asset Library, and Remove. A person pastes a Figma URL to add one.
//
// What it must never do:
//   * Say "0 comments" for a count nobody read. `openComments: null` is "Comments not read yet" (see `commentsText`).
//   * Hide the links when Figma is not connected, which is the normal state until DW-11. It shows them with their cached values
//     and one line, "Figma isn't connected for this company"; managers get a link to Tools & connections.
//   * Read an empty list as "no designs" when the read failed. `forbidden` and `unavailable` are said as themselves.
//
// The controls are COSMETIC: no page knows who may write, so Add, Remove and Export are always offered and the server decides
// (Cerbos on the target's own kind). A refusal is a sentence under the control, never a crash.
import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import type { ReadResult } from "@/lib/readResult";
import { addFigmaLinkAction, exportFigmaLinkAction, removeFigmaLinkAction } from "@/lib/figmaActions";
import {
  EXPORT_FORMATS, NOT_CONNECTED_LINE, changedText, commentsText, exportedText, safeFigmaHref, staleText, thumbnailSrc,
  type ExportFormat, type FigmaLink, type FigmaLinks, type FigmaTargetKind,
} from "@/lib/figma";
import "./designs.css";

export interface DesignsProps {
  targetKind: FigmaTargetKind;
  targetId: string;
  /** The links read, as a `ReadResult`: a refusal or a failed read is said in words, never shown as an empty list. */
  result: ReadResult<FigmaLinks>;
  /** The page's "now", in ms, so "changed 3 hours ago" is the same on the server and after hydration. */
  now: number;
  /** Where Tools & connections is, for a manager (`company.manage`) when Figma is not connected. Null: no link is offered. */
  connectionsHref?: string | null;
}

export function Designs({ targetKind, targetId, result, now, connectionsHref = null }: DesignsProps) {
  if (result.kind === "forbidden") {
    return <section className="fg" aria-label="Designs"><p className="fg-note">You can&apos;t see the designs linked here.</p></section>;
  }
  if (result.kind === "unavailable") {
    return (
      <section className="fg" aria-label="Designs">
        <p className="fg-note" role="status">The designs linked here can&apos;t be shown right now ({result.reason}). That doesn&apos;t mean there are none.</p>
      </section>
    );
  }
  const { figmaConnected, items } = result.data;
  return (
    <section className="fg" aria-label="Designs">
      {!figmaConnected && (
        <p className="fg-note" data-testid="figma-not-connected">
          {NOT_CONNECTED_LINE}.
          {connectionsHref ? <> <a href={connectionsHref}>Connect it under Tools &amp; connections</a>.</> : null}
        </p>
      )}
      {items.length === 0 ? (
        <p className="fg-empty">No Figma designs are linked here yet.</p>
      ) : (
        <ul className="fg-list">
          {items.map((l) => <LinkItem key={l.id} link={l} now={now} />)}
        </ul>
      )}
      <AddLink targetKind={targetKind} targetId={targetId} />
    </section>
  );
}

// ── one link ─────────────────────────────────────────────────────────────────────────────────────

function LinkItem({ link, now }: { link: FigmaLink; now: number }) {
  const router = useRouter();
  const [failedImage, setFailedImage] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const href = safeFigmaHref(link.url);
  const title = link.title ?? "Figma design";
  const changed = changedText(link.lastModified, now);

  function doExport() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await exportFigmaLinkAction(link.id, format);
      if (!res.ok) return setError(res.error);
      setDone(exportedText(format, res.export));
      router.refresh();
    });
  }

  function doRemove() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await removeFigmaLinkAction(link.id);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  return (
    <li className="fg-link" aria-label={title}>
      <div className="fg-thumb">
        {failedImage ? (
          <span className="fg-thumb__none">Preview unavailable</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a proxied, session-forwarded PNG that expires: not a next/image candidate
          <img src={thumbnailSrc(link.id)} alt={link.title ?? "Figma design (title not read yet)"} loading="lazy" onError={() => setFailedImage(true)} />
        )}
      </div>
      <div className="fg-body">
        <p className="fg-title">{link.title ?? "Title not read from Figma yet"}</p>
        <p className="fg-meta">
          <span>{changed ?? "Last change not read yet"}</span>
          <span aria-hidden="true"> · </span>
          {link.openComments !== null && href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">{commentsText(link.openComments)}</a>
          ) : (
            <span>{commentsText(link.openComments)}</span>
          )}
        </p>
        {link.stale && <p className="fg-stale">{staleText(link)}</p>}
        <div className="fg-actions">
          {href && <a href={href} target="_blank" rel="noopener noreferrer" className="fg-open">Open in Figma</a>}
          <label className="fg-format">
            <span className="fg-sr">Export format for {title}</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} disabled={pending}>
              {EXPORT_FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </label>
          <Button variant="ghost" size="sm" onClick={doExport} disabled={pending}>{pending ? "Working…" : "Export"}</Button>
          <Button variant="ghost" size="sm" onClick={doRemove} disabled={pending}>Remove</Button>
        </div>
        {done && <p className="fg-done" role="status">{done}</p>}
        {error && <p className="fg-error" role="alert">{error}</p>}
      </div>
    </li>
  );
}

// ── add a link ───────────────────────────────────────────────────────────────────────────────────

function AddLink({ targetKind, targetId }: { targetKind: FigmaTargetKind; targetId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url") ?? "").trim();
    if (!url) return setError("Paste a Figma link first.");
    setError(null);
    startTransition(async () => {
      const res = await addFigmaLinkAction(targetKind, targetId, url);
      if (!res.ok) return setError(res.error);
      formRef.current?.reset();
      router.refresh();
    });
  }

  return (
    <form ref={formRef} className="fg-add" onSubmit={submit} aria-label="Add a Figma link">
      <label className="fg-add__label">
        <span>Figma link</span>
        <input name="url" type="text" inputMode="url" autoComplete="off" placeholder="https://www.figma.com/design/…" disabled={pending} />
      </label>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Adding…" : "Add"}</Button>
      {error && <p className="fg-error" role="alert">{error}</p>}
    </form>
  );
}
