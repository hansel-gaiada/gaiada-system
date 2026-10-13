"use client";
import { CapabilityCards } from "./CapabilityCards";

// ASST-18 — the "capabilities" panel (blueprint §8's context inspector family). Chrome only: all of the
// actual data loading + rendering lives in `CapabilityCards`, which this panel shares verbatim with the
// empty-state cards.
//
// DW-2h — this is the Capabilities TAB of the Details panel (`DetailsPanel`), which owns the title row and the
// close button, so the panel renders only its body.
export function CapabilitiesPanel() {
  return (
    <div id="asst-capabilities-panel" className="asst-cap">
      <p className="asst-cap__hint">Exactly what you can ask the assistant to do — tools you don&rsquo;t have access to simply don&rsquo;t appear here.</p>
      <div className="asst-cap__body">
        <CapabilityCards />
      </div>
    </div>
  );
}
