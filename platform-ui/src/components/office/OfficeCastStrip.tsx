"use client";

/**
 * OfficeCastStrip — a horizontal strip of "cast" cards along the bottom of The Office page,
 * one card per person/agent/automation on the floor (modelled on the agent strip in a
 * multi-agent desktop app: avatar tile, name, status pill). Clicking a card selects that
 * avatar on the floor, mirroring `.office__roster`'s listbox semantics (OfficeCanvas.tsx)
 * but laid out as a horizontal filmstrip instead of a vertical list.
 *
 * HUMAN/STATUS ASYMMETRY — read this before touching the status pill:
 * `CastMember.status` is `null` for every human on purpose (see
 * docs/superpowers/plans/2026-08-23-virtual-office-plan.md §3). There is no activity feed for
 * people comparable to an agent run or an automation's execution state, so a working/idle/
 * active badge on a human card would be a fabricated surveillance claim, not a real status.
 * This component renders NOTHING in the status slot when `status` is null — never a default
 * like "idle" — so the absence of a badge honestly means "no status is claimed," not "this
 * person is idle." Do not add a fallback label here.
 */

import type { JSX } from "react";
import type { OfficeKind } from "@/lib/office";
import "./cast-strip.css";

export interface CastMember {
  id: string;
  name: string;
  kind: OfficeKind; // "human" | "agent" | "automation" | "external"
  roomLabel: string; // e.g. "Web Dev"
  /** Real activity status. NULL for every human — see the honesty rule above. */
  status: { label: string; tone: "ok" | "warning" | "danger" } | null;
}

const KIND_LABEL: Record<OfficeKind, string> = {
  human: "Human",
  agent: "Agent",
  automation: "Automation",
  external: "External",
};

export function OfficeCastStrip(props: {
  members: CastMember[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}): JSX.Element {
  const { members, selectedId, onSelect, onHover } = props;

  return (
    <div className="cast-strip" role="listbox" aria-label="Everyone on the floor" aria-orientation="horizontal">
      {members.length === 0 && <p className="cast-strip__empty">No avatars for this company yet.</p>}
      {members.map((m) => {
        const selected = m.id === selectedId;
        return (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={selected}
            className={`cast-strip__card${selected ? " cast-strip__card--selected" : ""}`}
            onFocus={() => onHover(m.id)}
            onBlur={() => onHover(null)}
            onMouseEnter={() => onHover(m.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onSelect(m.id)}
          >
            <span className={`cast-strip__avatar cast-strip__avatar--${m.kind}`} aria-hidden="true">
              {m.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="cast-strip__body">
              <span className="cast-strip__name">{m.name}</span>
              <span className="cast-strip__meta">
                {KIND_LABEL[m.kind]} · {m.roomLabel}
              </span>
              {/* Honesty rule: `status` is null for humans, and only for humans — render nothing
                  in that case rather than inventing a default label. */}
              {m.status && (
                <span className={`cast-strip__status cast-strip__status--${m.status.tone}`}>{m.status.label}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
