"use client";
import { lazy, Suspense, useId, useState } from "react";
import type { SiteScope } from "@/lib/webdeskContentActions";
import type { MediaValue } from "@/lib/webdeskMediaModel";
import "./media.css";

// "Choose from library" for a `media` field. The button is all that ships with the item editor: the library itself (grid,
// uploads, detail panel, server actions) is loaded the first time the dialog opens, so an editor that never touches an image
// field never pays for it.
//
// Choosing an asset writes the media primitive's value `{url, alt?, width?, height?, mime?}` (see `mediaValueFor`); the manual URL
// and alt inputs next to the button keep working as before, so a field can still point at an address the library doesn't hold.

const MediaPickerDialog = lazy(() => import("./MediaPickerDialog"));

/** What the item editor knows that the picker needs. Absent from `FormCtx` = no picker (the manual inputs only). */
export interface MediaPickerCtx {
  scope: SiteScope;
  /** `/departments/:deptId/website/content/:tenant/:site`, for "Where it's used" links. */
  routeBase: string;
  /** The language of the item being edited: the asset's alt for it becomes the value's alt. */
  locale: string;
  locales: string[];
  authors: Record<string, string>;
  /** Where WebDesk serves media from (thumbnails); null = type tiles. */
  publicBase: string | null;
}

export function MediaPickButton({
  ctx, label, onPick, disabled, text = "Choose from library", multiple = false,
}: {
  ctx: MediaPickerCtx;
  /** The field's label, for the button's accessible name. */
  label: string;
  onPick: (value: MediaValue) => void;
  disabled?: boolean;
  text?: string;
  /** Only changes the dialog's wording: the caller decides what picking does (replace or append). */
  multiple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  return (
    <>
      <button
        type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={disabled}
        aria-haspopup="dialog" aria-label={`${text}: ${label}`} onClick={() => setOpen(true)} data-testid="media-choose"
      >
        {text}
      </button>
      {open && (
        <Suspense fallback={<span className="wc-sr" role="status">Opening the media library…</span>}>
          <MediaPickerDialog
            open ctx={ctx} labelledBy={`${uid}-t`} multiple={multiple}
            onClose={() => setOpen(false)}
            onPick={(v) => { setOpen(false); onPick(v); }}
          />
        </Suspense>
      )}
    </>
  );
}
