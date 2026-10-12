import { reviewStateInfo } from "@/lib/webdeskEditorialModel";
import "./editorial.css";

/** A review state as a chip: the WORD is the signal, the glyph and the border style differ per state, the tone only reinforces them.
 *  An unknown state shows its own words on the neutral chip, never a guess. */
export function ReviewStateChip({ state, testId = "review-state" }: { state: string; testId?: string }) {
  const info = reviewStateInfo(state);
  return (
    <span className={`we-state we-state--${info.tone}`} data-testid={testId} data-state={state} title={info.sentence}>
      <span className="we-state__glyph" aria-hidden="true">{info.glyph}</span>
      {info.label}
    </span>
  );
}
