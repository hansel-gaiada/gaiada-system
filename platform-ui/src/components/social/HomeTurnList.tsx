"use client";
// SCP-1d (BFF §63.7 `GET feed?view=your_turn`; plan §6.2, §6.4) — the Home's "Your turn" cards: the posts the caller holds, health first, each as the design's feed
// card with its next allowed action as the main button.
//
// THE BUTTON IS THE SERVER'S `nextAction` (decided by the feed's one `checkMany`); this file adds no rule. See `mainButtonOf`:
//   allowed, needs no answer   a live button that posts the action as `PostActionBar` does (`runPostAction`, `expectedStatus` the step the card showed, a fresh action id);
//   allowed, needs an answer   a link styled as the button that opens the post (a note, a date or the hand-off checks are asked in the post's own dialog);
//   not allowed                a disabled button, with the reason in words (`reasonWords`) beside it, never colour alone;
//   no next action             nothing but the card's link.
// The card itself opens the post drawer (`{D}/posts/[postId]`, an intercepting route) through the title's link, stretched over the card; the button sits above it.
import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { runPostAction } from "@/lib/socialPipelineActions";
import { newActionId } from "@/lib/socialPipeline";
import { formatWords, phaseLabel, postHref, statusLabel } from "@/lib/socialClient";
import { mainButtonOf, type PipelineCard } from "@/lib/socialHome";
import { agoWords } from "@/lib/socialMessages";
import { HealthChip } from "./HealthChip";
import { SimulatedMark } from "./SimulatedMark";

/** How many cards the Home draws before "Show more". The feed page itself is bounded (the server clamps it to 50), and no card makes its own read. */
export const TURN_SHOWN = 8;

export function HomeTurnList({ cards, deptId, hasMore, nowIso }: { cards: PipelineCard[]; deptId: string; hasMore: boolean; nowIso: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? cards : cards.slice(0, TURN_SHOWN);
  const now = Date.parse(nowIso);
  return (
    <>
      <ul className="sh-cards">
        {shown.map((c) => <li key={c.id}><TurnCard card={c} deptId={deptId} now={now} /></li>)}
      </ul>
      {cards.length > TURN_SHOWN && !all && (
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm sh-more" onClick={() => setAll(true)}>
          Show the other {cards.length - TURN_SHOWN}
        </button>
      )}
      {(all || cards.length <= TURN_SHOWN) && hasMore && (
        <p className="scp-note">These are the first {cards.length} of your turn, the most urgent first. Finish some and the rest appear.</p>
      )}
    </>
  );
}

type RunState = { kind: "idle" } | { kind: "done"; text: string } | { kind: "error"; text: string };

function TurnCard({ card, deptId, now }: { card: PipelineCard; deptId: string; now: number }) {
  const uid = useId();
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [pending, start] = useTransition();
  const button = mainButtonOf(card);
  const href = postHref(deptId, card.id);

  function run(action: string, label: string) {
    setState({ kind: "idle" });
    start(async () => {
      const r = await runPostAction(card.id, { action, expectedStatus: card.pipelineStatus, actionId: newActionId() });
      setState(r.ok ? { kind: "done", text: `Done: ${label}.` } : { kind: "error", text: r.message });
    });
  }

  return (
    <article className="sh-card" data-phase={card.phase ?? ""} aria-label={`${card.clientName}: ${card.title}`}>
      <header className="sh-card__head">
        <span className="sh-avatar" aria-hidden="true">{card.clientName.charAt(0).toUpperCase()}</span>
        <div className="sh-card__who">
          <span className="sh-card__client">{card.clientName}{card.isExtra && <span className="sh-card__sub"> · extra post</span>}</span>
          <span className="sh-card__sub sh-card__sub--turn">Your turn{card.statusSince ? ` · ${agoWords(card.statusSince, now)}` : ""}</span>
        </div>
        <HealthChip health={card.health} />
      </header>
      <div className="sh-card__media" data-format={card.format ?? ""}>
        {card.thumbFileId
          // eslint-disable-next-line @next/next/no-img-element -- the file route streams the stored bytes; the title below names the post
          ? <img src={`/api/files/${encodeURIComponent(card.thumbFileId)}`} alt="" loading="lazy" />
          : <span className="sh-card__ph" aria-hidden="true">{formatWords(card.format)}</span>}
      </div>
      <div className="sh-card__body">
        <h3 className="sh-card__title">
          <Link href={href} className="sh-card__link">{card.title}</Link>
        </h3>
        <p className="sh-card__meta">
          {formatWords(card.format)} · {statusLabel(card.pipelineStatus)} · {phaseLabel(card.phase)}
          {card.simulated && <> · <SimulatedMark /></>}
        </p>
        {button.kind !== "none" && (
          <div className="sh-card__act">
            {button.kind === "run" && (
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={() => run(button.action, button.label)}>
                {pending ? "Working…" : button.label}
              </button>
            )}
            {button.kind === "open" && (
              <Link href={href} className="lux-btn lux-btn--solid lux-btn--sm">{button.label}</Link>
            )}
            {button.kind === "refused" && (
              <>
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled aria-describedby={`${uid}-why`}>{button.label}</button>
                <span id={`${uid}-why`} className="sh-card__why">{button.reason}</span>
              </>
            )}
          </div>
        )}
        <p role={state.kind === "error" ? "alert" : "status"} className={`scp-msg sh-card__status ${state.kind === "error" ? "scp-msg--error" : "scp-msg--ok"}`}>
          {state.kind !== "idle" && state.text}
        </p>
      </div>
    </article>
  );
}
