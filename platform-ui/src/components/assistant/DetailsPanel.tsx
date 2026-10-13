"use client";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { MemoryPanel } from "./MemoryPanel";
import { RosterPanel } from "./RosterPanel";
import { CapabilitiesPanel } from "./CapabilitiesPanel";

// DW-2h — the ONE Details panel. Memory, Roster and Capabilities used to be three controls that each opened a
// panel in the right-hand slot, one at a time. They are now three tabs of one panel, closed by default (the
// conversation gets the full width) and opened by one "Details" control, or by an entry point that wants a
// specific tab (the empty state's "See everything I can do" opens Capabilities).
//
// Only the selected tab's body is mounted, as before: each panel loads its own data on mount and the roster
// polls its hand-offs, and none of that should run for a tab nobody is looking at.
export type DetailsTab = "memory" | "roster" | "capabilities";

export const DETAILS_TABS: readonly { key: DetailsTab; label: string }[] = [
  { key: "memory", label: "Memory" },
  { key: "roster", label: "Roster" },
  { key: "capabilities", label: "Capabilities" },
];

export const DETAILS_PANEL_ID = "asst-details-panel";

export function DetailsPanel({ tab, onTab, onClose, activeThreadId }: {
  tab: DetailsTab;
  onTab: (tab: DetailsTab) => void;
  onClose: () => void;
  activeThreadId: string | null;
}) {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Opening the panel moves focus to the selected tab, so a keyboard user lands inside it; closing hands focus
  // back to the Details control (the workspace does that, it owns the control).
  useEffect(() => {
    tabRefs.current[tab]?.focus();
    // Once per open: switching tabs keeps focus on the tab that was just chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The WAI-ARIA tabs pattern: arrows (and Home/End) move between tabs, selection follows focus, and only the
  // selected tab is in the Tab order.
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const target = e.target as HTMLElement;
    // A field inside a tab (the memory draft, an edit) keeps its own keys: arrows move its caret, Escape cancels its edit.
    if (target.closest("input, textarea, select")) return;
    if (e.key === "Escape") {
      // Stop here so a drawer's own Escape (close the whole drawer) does not also fire: Escape peels one layer.
      e.stopPropagation();
      onClose();
      return;
    }
    if (target.getAttribute("role") !== "tab") return;
    const i = DETAILS_TABS.findIndex((t) => t.key === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % DETAILS_TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + DETAILS_TABS.length) % DETAILS_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = DETAILS_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = DETAILS_TABS[next].key;
    onTab(key);
    tabRefs.current[key]?.focus();
  }

  return (
    <aside id={DETAILS_PANEL_ID} className="asst-details" aria-label="Assistant details" onKeyDown={onKeyDown}>
      <div className="asst-details__head">
        <h2 className="asst-details__title">Details</h2>
        <button type="button" className="asst-details__close" aria-label="Close details" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <div className="asst-details__tabs" role="tablist" aria-label="Details sections">
        {DETAILS_TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => { tabRefs.current[t.key] = el; }}
            type="button"
            role="tab"
            id={`asst-details-tab-${t.key}`}
            className="asst-details__tab"
            aria-selected={tab === t.key}
            aria-controls="asst-details-tabpanel"
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => onTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="asst-details-tabpanel" className="asst-details__body" role="tabpanel" aria-labelledby={`asst-details-tab-${tab}`}>
        {tab === "memory" && <MemoryPanel activeThreadId={activeThreadId} />}
        {tab === "roster" && <RosterPanel activeThreadId={activeThreadId} />}
        {tab === "capabilities" && <CapabilitiesPanel />}
      </div>
    </aside>
  );
}
