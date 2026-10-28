import "@/components/social/simulated-mark.css";
import { SIMULATED_ACCOUNT_NOTE } from "@/lib/socialShared";

// SCP-Sf (plan §5 "Marking"; generalises SCP-Sb's SimulatedAccountChip): THE one SIMULATED mark of the Social Media pipeline. Every screen that shows a simulated
// thing draws exactly this: a simulated account, a post that went live through the simulator, a variant the simulator served, a simulated metric or daily row.
// One look and one accessible name, so a person learns it once and a test can find it anywhere.
//
//  - The word SIMULATED is in the markup, in capitals, so the mark is never colour alone and survives a print or a screenshot.
//  - `role="img"` + `aria-label="Simulated"` gives it one accessible name a screen reader says as a word (not "S-I-M-…") and that a test asks for by role
//    (`getAllByRole("img", { name: "Simulated" })`), the same pattern as the other status marks here ("1 blocked", "Unread"). `title` carries the sentence of
//    what is simulated about it (its accessible description), and `withNote` writes that sentence out beside the mark where the thing is the whole subject.
//  - The render pin (`SimulatedMark.pin.test.tsx`) fails if a component that receives a simulated item renders it without this mark, and if a new component that
//    reads `.simulated` is added without being pinned.
//
// The monthly report (SCP-5a, not built) watermarks its page and its PDF with this mark and a `simulated` flag on the report (plan §5; BFF §63.1 file 9).

/** The mark's accessible name: one word, everywhere. */
export const SIMULATED_MARK_NAME = "Simulated";

/** What the mark says it means, by the kind of thing it marks (its title, and the note `withNote` writes out). */
export const SIMULATED_NOTES = {
  account: SIMULATED_ACCOUNT_NOTE,
  post: "Simulated: this post went live through the social simulator for the dev review. It is on no real account.",
  variant: "Simulated: the social simulator served this network. Nothing reached a real account.",
  metrics: "Simulated numbers from the social simulator, for the dev review. They are not a network's figures.",
  action: "Runs the social simulator only. Nothing reaches a real account.",
} as const;
export type SimulatedNoteKind = keyof typeof SIMULATED_NOTES;

export function SimulatedMark({ of = "post", withNote = false, className }: {
  /** What is simulated (the title and the written note). */
  of?: SimulatedNoteKind;
  /** Write the sentence out beside the mark (where the simulated thing is the whole subject, e.g. an account on Connections). */
  withNote?: boolean;
  /** Placement only (e.g. the Feed preview tile's corner); the look is the mark's own. */
  className?: string;
}) {
  const note = SIMULATED_NOTES[of];
  return (
    <>
      <span className={className ? `scp-sim-mark ${className}` : "scp-sim-mark"} role="img" aria-label={SIMULATED_MARK_NAME} title={note} data-simulated-mark="">
        SIMULATED
      </span>
      {withNote && <span className="scp-sim-mark__note">{note}</span>}
    </>
  );
}
