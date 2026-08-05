"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PinnedPageContext } from "@/lib/assistant";
import { resolveCitationAction } from "@/lib/assistantActions";

// ASST-22 — the drawer/page toolbar's page-context pin. Deliberately its OWN small component
// rather than a literal reuse of `CitationChips` (composed one level up, in the same tree): that
// component always renders the fixed label "Source"/"Source unavailable" — correct for an
// anonymous knowledge-retrieval hit, wrong here, since the whole point of this chip is to NAME the
// pinned entity. It still reuses the exact SAME resolve-then-navigate discipline
// (`resolveCitationAction`, ASST-18's "a chip that 404s is worse than no chip" bar) rather than
// trusting the `href` the drawer route resolved moments ago blindly — a real, if rare, window
// exists between that server render and the click (the entity gets renamed or deleted mid-session).
export function PageContextChip({ context }: { context: PinnedPageContext }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "resolving" | "unavailable">("idle");

  async function handleClick() {
    if (state === "resolving") return;
    setState("resolving");
    const r = await resolveCitationAction(context.ref);
    if (!r.ok || !r.resolved) {
      setState("unavailable");
      return;
    }
    setState("idle");
    router.push(r.resolved.href);
  }

  const unavailable = state === "unavailable";
  return (
    <button
      type="button"
      className={`asst-context-chip${unavailable ? " asst-context-chip--unavailable" : ""}`}
      disabled={unavailable || state === "resolving"}
      title={unavailable ? "This page is no longer available" : `Pinned context — ${context.ref}`}
      onClick={handleClick}
    >
      {unavailable ? "Context unavailable" : `Pinned: ${context.label}`}
    </button>
  );
}
