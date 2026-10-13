import { useId } from "react";

// DW-2c: the workspace shell's version of SpecialAccessBanner. The full-width strip becomes a small chip
// in the top bar; the strip's whole sentence, including that actions are logged and reported, is the
// chip's accessible description and shows as a tooltip on hover and keyboard focus. Same facts, same
// wording as the strip (SpecialAccessBanner.tsx), less of the page.
export function specialAccessSentence(unrestricted: boolean): string {
  return `Every company${unrestricted ? ", editable" : ""} — actions are logged and reported.`;
}

export function SpecialAccessChip({ unrestricted }: { unrestricted: boolean }) {
  const tip = useId();
  return (
    <span className="erp-top__chipwrap">
      <span className="erp-top__chip" tabIndex={0} role="note" aria-describedby={tip}>
        {unrestricted ? "Unrestricted" : "Elevated"}
      </span>
      <span className="erp-top__chiptip" id={tip} role="tooltip">{specialAccessSentence(unrestricted)}</span>
    </span>
  );
}
