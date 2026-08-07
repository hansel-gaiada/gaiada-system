"use client";

// Owner complaint (2026-08-07): a brand-new chat used to dump the FULL tool catalogue — raw names
// like `activity.feed`/`workActivity.relink` plus developer-facing prose — as the very first thing
// anyone saw. That catalogue (`CapabilityCards`) still exists and still has real value for a power
// user, but it now lives ONLY behind the toolbar's existing "Capabilities" button
// (`AssistantWorkspace`'s `capabilitiesOpen` panel) — never inline here. This component is what
// replaces it in the empty state: a short, curated set of things a person actually wants to do,
// phrased as questions/asks rather than tool identifiers, plus one explicit escape hatch to the
// full catalogue for anyone who wants it.
//
// `prompt` (the text a click hands to the composer) intentionally differs from `label` (the tile's
// own short copy): the tile stays scannable at a glance, the composer gets a real first-person
// sentence the user can just press Enter on — or edit first. Nothing here auto-sends; see
// `Composer`'s `prefill` prop header for why a suggestion must never look like the assistant sent
// something on the user's behalf.
const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: "Ask about your projects", prompt: "What's the status of my active projects right now?" },
  { label: "Draft a task", prompt: "Draft a task for my team about " },
  { label: "Check what's waiting on you", prompt: "What approvals or reviews are waiting on me?" },
  { label: "Catch up on time entries", prompt: "Have I logged time for all of my work this week?" },
];

export function EmptyStateSuggestions({ onPick, onOpenCapabilities }: {
  /** Hands the suggestion's full prompt text up to the composer — never sends it directly. */
  onPick: (prompt: string) => void;
  /** The discoverability escape hatch: opens the SAME right-rail panel the toolbar's "Capabilities"
   *  button does (see AssistantWorkspace) — the raw catalogue is relocated, not deleted. */
  onOpenCapabilities: () => void;
}) {
  return (
    <div className="asst-suggestions">
      {SUGGESTIONS.map((s) => (
        <button key={s.label} type="button" className="asst-suggestion" onClick={() => onPick(s.prompt)}>
          <span className="asst-suggestion__label">{s.label}</span>
        </button>
      ))}
      <button
        type="button"
        className="asst-suggestion asst-suggestion--more"
        onClick={onOpenCapabilities}
      >
        <span className="asst-suggestion__label">See everything I can do</span>
      </button>
    </div>
  );
}
