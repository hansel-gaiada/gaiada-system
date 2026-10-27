"use client";
import { useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "@/components/overlay/Modal";
import { PinOverlay } from "@/components/social/PinOverlay";
import { CHANGE_NOTE_MAX, changeProblem, portalSocialFileHref, type PortalSocialPost } from "@/lib/portalSocial";
import type { CommentAnchor } from "@/lib/pm";
import type { ChangeInput, ChangeResult } from "./usePostDecision";

// SCP-2 (BFF §63.9, plan SCP-2d) — "Ask for changes": what kind of change (the text, or the design: required), a note (1 to 2,000 characters:
// required) and, optionally, a pin on the picture. The pin is the staff post page's own `PinOverlay`; its anchor is `{x, y, fileId}` with the
// fractions of the image (0 to 1) and the FULL file (the dialog opens the image at its full size, not the thumbnail the list shows).
//
// It checks what the server checks (`changeProblem`) before sending, and shows the server's own refusals in words, on the field they name. Focus: the
// Modal puts it on the dialog and gives it back to the button that opened it. The pin can be placed from the keyboard (the overlay's arrow keys).
export function PortalSocialChangeDialog({ post, tenant, open, onClose, onSubmit, busy }: {
  post: PortalSocialPost;
  tenant: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (input: ChangeInput) => Promise<ChangeResult>;
  busy: boolean;
}) {
  const uid = useId();
  const [kind, setKind] = useState<"copy" | "design" | null>(null);
  const [note, setNote] = useState("");
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const [placing, setPlacing] = useState(false);
  const [imageIx, setImageIx] = useState(0);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const kindRef = useRef<HTMLInputElement>(null);

  const images = post.images;
  const image = images[Math.min(imageIx, Math.max(0, images.length - 1))];
  const noteLen = [...note.trim()].length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const p = changeProblem(kind, note);
    if (p) {
      setProblem(p);
      (p.field === "note" ? noteRef.current : kindRef.current)?.focus();
      return;
    }
    setProblem(null);
    const r = await onSubmit({ changeKind: kind as "copy" | "design", note, ...(anchor ? { anchor } : {}) });
    if (r.ok) { onClose(); return; }
    if (r.reloaded) { onClose(); return; }
    setProblem({ field: r.field ?? "form", message: r.error });
    if (r.field === "note") noteRef.current?.focus();
  }

  const kindError = problem?.field === "changeKind" ? problem.message : null;
  const noteError = problem?.field === "note" ? problem.message : null;
  const formError = problem && problem.field !== "changeKind" && problem.field !== "note" ? problem.message : null;

  return (
    <Modal open={open} onClose={onClose} title="Ask for changes" size="md">
      <form className="ps-change" onSubmit={(e) => void submit(e)} noValidate>
        <p className="ps-change__lead">Tell us what to change in &ldquo;{post.title}&rdquo;. We will make the change and send it back to you.</p>
        {formError && <div className="cp-form__error" role="alert">{formError}</div>}

        <fieldset className="ps-change__kind" aria-describedby={kindError ? `${uid}-kind-err` : undefined}>
          <legend className="cp-field__label">What needs to change? (required)</legend>
          <label className="cp-check">
            <input ref={kindRef} type="radio" name={`${uid}-kind`} value="copy" checked={kind === "copy"} onChange={() => setKind("copy")} aria-invalid={kindError ? true : undefined} />
            <span>The text: the caption, the hashtags or the words on the picture</span>
          </label>
          <label className="cp-check">
            <input type="radio" name={`${uid}-kind`} value="design" checked={kind === "design"} onChange={() => setKind("design")} aria-invalid={kindError ? true : undefined} />
            <span>The design: the picture, the layout or the colours</span>
          </label>
          {kindError && <div id={`${uid}-kind-err`} className="cp-form__error" role="alert">{kindError}</div>}
        </fieldset>

        <div className="cp-field">
          <label className="cp-field__label" htmlFor={`${uid}-note`}>What should we change? (required)</label>
          <textarea
            id={`${uid}-note`} ref={noteRef} className="cp-textarea" rows={4} value={note} onChange={(e) => setNote(e.target.value)}
            aria-invalid={noteError ? true : undefined} aria-describedby={`${uid}-note-hint${noteError ? ` ${uid}-note-err` : ""}`}
            placeholder="For example: make the product larger and move the logo to the top corner."
          />
          <span id={`${uid}-note-hint`} className={`cp-composer__count${noteLen > CHANGE_NOTE_MAX ? " cp-composer__count--over" : ""}`}>
            {noteLen.toLocaleString("en-GB")} of {CHANGE_NOTE_MAX.toLocaleString("en-GB")} characters
          </span>
          {noteError && <div id={`${uid}-note-err`} className="cp-form__error" role="alert">{noteError}</div>}
        </div>

        {image && (
          <div className="cp-field">
            <span className="cp-field__label">Point to the spot (optional)</span>
            <div className="ps-change__pin">
              {/* The full file, not the thumbnail: the pin is a fraction of this image. */}
              <PinOverlay
                src={portalSocialFileHref(tenant, image.fileId)} alt={image.alt} fileId={image.fileId}
                pins={anchor && anchor.fileId === image.fileId ? [{ id: "new-pin", n: 1, anchor, label: "your pin" }] : []}
                placing={placing} onPlace={(a) => { setAnchor(a); setPlacing(false); }} onCancelPlace={() => setPlacing(false)} loading="lazy"
              />
            </div>
            <div className="ps-change__pinbar">
              {images.length > 1 && (
                <label className="ps-change__which">
                  <span className="cp-field__hint">Picture</span>
                  <select className="cp-select" value={imageIx} onChange={(e) => { setImageIx(Number(e.target.value)); setPlacing(false); }}>
                    {images.map((im, i) => <option key={im.fileId} value={i}>{`${i + 1} of ${images.length}`}</option>)}
                  </select>
                </label>
              )}
              <button type="button" className="btn ps-btn" onClick={() => setPlacing((v) => !v)} aria-pressed={placing}>
                {placing ? "Cancel placing" : anchor ? "Move the pin" : "Place a pin"}
              </button>
              {anchor && <button type="button" className="btn ps-btn" onClick={() => { setAnchor(null); setPlacing(false); }}>Remove the pin</button>}
            </div>
            <span className="cp-field__hint" role="status">
              {placing ? "Click the spot on the picture, or use the arrow keys and Enter." : anchor ? "Your pin is on the picture." : "A pin shows us exactly where you mean."}
            </span>
          </div>
        )}

        <div className="ps-change__foot">
          <button type="button" className="btn ps-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary ps-btn" disabled={busy}>{busy ? "Sending…" : "Send changes"}</button>
        </div>
      </form>
    </Modal>
  );
}
