"use client";
import { MediaDialog } from "./MediaDialog";
import { MediaLibrary } from "./MediaLibrary";
import type { MediaPickerCtx } from "./MediaPicker";
import type { MediaValue } from "@/lib/webdeskMediaModel";

/** The picker dialog: the whole library in pick mode, inside a modal. Loaded lazily by `MediaPickButton`. */
export default function MediaPickerDialog({
  open, ctx, labelledBy, multiple, onClose, onPick,
}: {
  open: boolean; ctx: MediaPickerCtx; labelledBy: string; multiple: boolean; onClose: () => void; onPick: (value: MediaValue) => void;
}) {
  return (
    <MediaDialog open={open} onClose={onClose} labelledBy={labelledBy} wide testId="media-picker">
      <MediaLibrary
        mode="pick" headingId={labelledBy}
        scope={ctx.scope} routeBase={ctx.routeBase} locales={ctx.locales} pickLocale={ctx.locale}
        initial={null} authors={ctx.authors} publicBase={ctx.publicBase} driver={ctx.driver}
        onPick={(value) => onPick(value)} onClose={onClose}
      />
      {multiple && <p className="wc-muted">This field takes several images: the one you choose is added to the end of the list.</p>}
    </MediaDialog>
  );
}
