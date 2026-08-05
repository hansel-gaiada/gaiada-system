"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AssistantCitation } from "@/lib/assistant";
import { resolveCitationAction } from "@/lib/assistantActions";

// ASST-18 — the citation chip row under a knowledge-grounded reply. The ticket's own bar: "a chip
// that 404s is worse than no chip." So a chip is NEVER a plain `<a href>` pointing at a guess — on
// click it resolves the ref FIRST (`resolveCitationAction` -> `GET .../assistant/citations/:ref`,
// citations.ts's narrow, honest mapping) and only THEN navigates, to the real href the backend
// verified still exists. A ref that doesn't resolve renders as a disabled, non-navigating chip with
// a tooltip explaining why — never a link that promises a destination it cannot deliver.
export function CitationChips({ citations }: { citations: AssistantCitation[] }) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, "idle" | "resolving" | "unavailable">>({});

  async function handleClick(sourceRef: string) {
    if (state[sourceRef] === "resolving") return;
    setState((s) => ({ ...s, [sourceRef]: "resolving" }));
    const r = await resolveCitationAction(sourceRef);
    if (!r.ok || !r.resolved) {
      setState((s) => ({ ...s, [sourceRef]: "unavailable" }));
      return;
    }
    setState((s) => ({ ...s, [sourceRef]: "idle" }));
    router.push(r.resolved.href);
  }

  return (
    <div className="asst-cite-row" aria-label="Sources">
      {citations.map((c) => {
        const st = state[c.sourceRef] ?? "idle";
        const unavailable = st === "unavailable";
        return (
          <button
            key={c.sourceRef}
            type="button"
            className={`asst-cite-chip${unavailable ? " asst-cite-chip--unavailable" : ""}`}
            disabled={unavailable || st === "resolving"}
            title={unavailable ? "This source is no longer available" : c.text}
            onClick={() => handleClick(c.sourceRef)}
          >
            {unavailable ? "Source unavailable" : "Source"}
          </button>
        );
      })}
    </div>
  );
}
