"use client";
import { CapabilityCards } from "./CapabilityCards";

// ASST-18 — the right-rail "capabilities" panel (blueprint §8's context inspector family — same
// slot MemoryPanel occupies, one at a time; see AssistantWorkspace's toggle wiring). Chrome only:
// all of the actual data loading + rendering lives in `CapabilityCards`, which this panel shares
// verbatim with the empty-state cards.
export function CapabilitiesPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside id="asst-capabilities-panel" className="asst-cap" aria-label="Assistant capabilities">
      <div className="asst-cap__head">
        <p className="type-eyebrow" style={{ color: "var(--erp-accent)" }}>Capabilities</p>
        <button type="button" className="asst-cap__close" aria-label="Close capabilities panel" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
      <p className="asst-cap__hint">Exactly what you can ask the assistant to do — tools you don&rsquo;t have access to simply don&rsquo;t appear here.</p>
      <div className="asst-cap__body">
        <CapabilityCards variant="panel" />
      </div>
    </aside>
  );
}
