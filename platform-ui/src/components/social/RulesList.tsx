"use client";
// SCP-5 W5-C5 — the Up, Down and Remove buttons of one item in an editable list (a notes area, a cycle step, a dimension, a band, a category). Each button names its item, so a screen reader and a
// keyboard user know which one it acts on; Up is off for the first item and Down for the last.
export function ItemButtons({ label, index, count, onMove, onRemove, removeDisabled, removeHint }: {
  label: string;
  index: number;
  count: number;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  removeDisabled?: boolean;
  removeHint?: string;
}) {
  return (
    <div className="rules__buttons">
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${label} up`}>Up</button>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${label} down`}>Down</button>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onRemove} disabled={removeDisabled} title={removeDisabled ? removeHint : undefined} aria-label={`Remove ${label}`}>Remove</button>
    </div>
  );
}
