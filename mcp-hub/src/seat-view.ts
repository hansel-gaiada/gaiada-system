// Per-principal tool view (P1 item 15) — LAYER 2 of the three-layer allow-list.
//
// Design: docs/superpowers/plans/2026-08-10-hermes-orchestration-architecture.md §4, "Where the tool
// allow-list is ACTUALLY enforced":
//
//     1. `AgentDef.tools` in ai-agents  — ergonomics and eval determinism
//     2. the HUB TOOL VIEW (this file)  — keeps the model's context small AND removes the
//                                          hallucinated-tool failure mode
//     3. Cerbos                          — THE AUTHORITY
//
// **Layers 1 and 2 are mirrors. Cerbos is the authority.** Nothing here grants anything; a seat that
// slipped past this filter would still be denied at the call. So this file's job is not security —
// it is to stop a seat being SHOWN ~70 tools it has no business holding, which is exactly the defect
// the whole demotion exists to correct: Hermes today holds the entire aggregated surface as one flat
// list under one identity.
//
// ── WHO GETS FILTERED, AND WHY THE ANSWER IS "ONLY SEATS" ────────────────────────────────────────
// Only principals carrying an `agent:` marker are narrowed. A human on an interactive surface is not
// a seat — their gate is assurance (and, for n8n, the workflow allow-list), both of which already
// exist and are untouched here. Filtering humans by a registry they do not appear in would deny the
// estate's actual users, which is not a security improvement but an outage.
//
// ── AND WHY AN UNRESOLVABLE SEAT GETS NOTHING ───────────────────────────────────────────────────
// This is the one genuinely contestable choice, so the reasoning is recorded rather than assumed.
// The tempting fallback is "on a lookup failure, show everything, because Cerbos still gates it".
// That is true about SAFETY and wrong about PURPOSE: it means a registry blip silently restores the
// pre-demotion behaviour — Hermes holding every tool — and nothing would surface it, because every
// call still succeeds. A seat that cannot be resolved therefore sees an EMPTY view and says so.
// Compare `revocation.ts`, which fails OPEN, deliberately and for the opposite reason: there the
// failure mode of closing is denying a real human their access.
import { config } from "./config";
import type { Principal } from "./principal";
import type { HubTool } from "./registry";

export interface SeatView {
  /** `undefined` when this principal is not a seat — the caller must then not filter at all. */
  seat?: string;
  /** Namespaces this seat may SEE. Empty array = show nothing (see the header). */
  namespaces: string[];
  resolved: boolean;
  reason?: string;
}

const NOT_A_SEAT: SeatView = { namespaces: [], resolved: true };

interface CacheEntry {
  view: SeatView;
  expires: number;
}
const cache = new Map<string, CacheEntry>();

export function resetSeatCache(): void {
  cache.clear();
}

/**
 * The seat name behind a principal, or undefined if this caller is not a seat.
 *
 * `runAgent` stamps `agent: \`agent:${def.name}\``, so the prefix is stripped here rather than at
 * every call site. A marker that is present but malformed returns undefined — it is not a seat name,
 * and inventing one would look up a row that cannot exist.
 */
export function seatNameOf(p: Principal): string | undefined {
  const a = typeof p.agent === "string" ? p.agent.trim() : "";
  if (!a.startsWith("agent:")) return undefined;
  const name = a.slice("agent:".length).trim();
  return name || undefined;
}

/** The namespace a tool belongs to: everything before the first dot. `pm.listTasks` -> `pm`. */
export function namespaceOf(toolName: string): string {
  const i = toolName.indexOf(".");
  return i === -1 ? toolName : toolName.slice(0, i);
}

/**
 * Resolve this principal's seat to its registry namespaces, cached for `revocationTtlMs`.
 *
 * Reuses the revocation TTL deliberately: both answer "what is true about this caller right now",
 * both go to the same platform, and a second independent freshness window is a second thing to
 * reason about when a seat is changed and does not take effect.
 */
export async function resolveSeatView(
  p: Principal,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<SeatView> {
  const seat = seatNameOf(p);
  if (!seat) return NOT_A_SEAT;
  if (!config.platformUrl) {
    return { seat, namespaces: [], resolved: false, reason: "platform not configured" };
  }

  const hit = cache.get(seat);
  if (hit && hit.expires > now) return hit.view;

  let view: SeatView;
  try {
    const res = await fetchImpl(`${config.platformUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${config.platformToken}` },
    });
    if (!res.ok) {
      view = { seat, namespaces: [], resolved: false, reason: `platform /api/agents ${res.status}` };
    } else {
      const body = (await res.json()) as { seats?: Array<{ name?: string; toolNamespaces?: string[]; enabled?: boolean }> };
      const row = (body.seats ?? []).find((s) => s.name === seat);
      if (!row) {
        // A seat the registry does not know is not a seat with broad rights — it is a seat that was
        // never enabled, or was disabled, or is misspelled. All three deserve an empty view.
        view = { seat, namespaces: [], resolved: false, reason: `seat not in registry: ${seat}` };
      } else if (row.enabled === false) {
        view = { seat, namespaces: [], resolved: true, reason: `seat disabled: ${seat}` };
      } else {
        view = { seat, namespaces: row.toolNamespaces ?? [], resolved: true };
      }
    }
  } catch (err) {
    view = { seat, namespaces: [], resolved: false, reason: `platform unreachable: ${(err as Error).message}` };
  }

  // An UNRESOLVED view is never cached. One blip must not blind a seat for a whole TTL — the same
  // reasoning as revocation.ts's "never caches `unavailable`", pointing the other way.
  if (view.resolved) cache.set(seat, { view, expires: now + config.revocationTtlMs });
  return view;
}

/**
 * Narrow a tool list to what this seat may see. A non-seat principal is returned unchanged.
 *
 * `agents.*` is ALWAYS visible to a seat, whatever its namespaces say. Without it a seat could not
 * report status or hand work on, and a router whose own `agents.*` had been filtered away by a
 * registry typo would be silently inert — able to answer, unable to route, with nothing to show for
 * it. This is the one deliberate exception and it grants no business reach.
 */
export function filterToolsForSeat(tools: HubTool[], view: SeatView): HubTool[] {
  if (!view.seat) return tools;
  const allowed = new Set(view.namespaces);
  return tools.filter((t) => {
    const ns = namespaceOf(t.name);
    return ns === "agents" || allowed.has(ns);
  });
}
