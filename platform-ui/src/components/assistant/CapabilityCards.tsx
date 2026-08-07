"use client";
import { useEffect, useState } from "react";
import { groupCapabilities, type AssistantCapability } from "@/lib/assistant";
import { refreshCapabilitiesAction } from "@/lib/assistantActions";

// ASST-18 — the full tool catalogue, rendered by the right-rail capabilities panel
// (`CapabilitiesPanel`), reached from the toolbar's "Capabilities" button OR the empty state's own
// "See everything I can do" tile (`EmptyStateSuggestions`) — see ThreadView's 2026-08-07 note for
// why the raw catalogue no longer renders inline in a brand-new chat. Calls
// `refreshCapabilitiesAction` — the SAME server action, hitting the SAME
// `GET :tenantId/assistant/capabilities` — so there is exactly one fetch function in this whole
// surface that can produce a capability list; don't give any caller its own copy.
export function CapabilityCards() {
  const [tools, setTools] = useState<AssistantCapability[] | null>(null);
  const [hubConfigured, setHubConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await refreshCapabilitiesAction();
      if (!alive) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setError(null);
      setTools(r.tools);
      setHubConfigured(r.hubConfigured);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="asst-cap__error" role="alert">{error}</p>;
  if (tools === null) return <p className="asst-cap__empty">Loading capabilities…</p>;
  // ASST-18 — fails CLOSED all the way to the render: an unreachable/misconfigured hub already
  // yielded an empty `tools` array server-side (never a cached or optimistic list — see
  // capabilities.ts's header), and THIS is where that honestly says so rather than rendering "you
  // have zero capabilities" as if it were a real Cerbos decision.
  if (!hubConfigured) return <p className="asst-cap__empty">The assistant&rsquo;s tool catalogue isn&rsquo;t reachable right now.</p>;
  if (tools.length === 0) return <p className="asst-cap__empty">No capabilities are available to you yet.</p>;

  const groups = groupCapabilities(tools);
  return (
    <div className="asst-cap-cards">
      {groups.map((g) => (
        <section key={g.category} className="asst-cap-card" aria-label={g.category}>
          <h3 className="asst-cap-card__title">{g.category}</h3>
          <ul className="asst-cap-card__list">
            {g.tools.map((t) => (
              <li key={t.name} className="asst-cap-card__tool">
                <span className="asst-cap-card__tool-name">{t.name}</span>
                {t.description && <span className="asst-cap-card__tool-desc">{t.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
