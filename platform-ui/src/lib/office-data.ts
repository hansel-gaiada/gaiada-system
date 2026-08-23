import "server-only";
// The Office — scene assembly (server-only). Combines REAL org data with clearly-labelled demo
// fixtures per docs/superpowers/plans/2026-08-23-virtual-office-plan.md §4.3's binding model.
//
// What is REAL here: rooms (one per org-structure department, via the same `listDepartmentBriefs`
// nav/dept consoles already use) and human avatars (real placements from `getDepartment`, the same
// data the Team Roster card renders). What is FIXTURE: which room an automation/agent/external
// seat rests in and the two demo movement events — none of that is backed by a live presence or
// event spine (plan §O0 is not built), and every avatar's `note` says so plainly rather than
// implying otherwise. No location HISTORY is stored anywhere — this function reads current org
// data and returns a fresh scene on every call; nothing here is a table.
import { listDepartmentBriefs, getDepartment, type DeptBrief } from "./departments";
import { getAgentGoals, getAgentGoal, type AgentGoal } from "./admin";
import {
  buildFloors,
  type OfficeRoomInput,
  type OfficeAvatar,
  type OfficeMoveEvent,
  type OfficeScene,
} from "./office";

export const OFFICE_LOBBY_KEY = "lobby";
export const OFFICE_AGENTS_KEY = "agents";
export const OFFICE_UTILITY_KEY = "utility";
// Reserved for a GENUINE binding failure (a real avatar with nowhere real to stand) — never
// created by default. Agents used to land here on the reasoning "goals are tenant-wide, not
// department-scoped" — true, but the wrong conclusion: tenant-wide is not unbound, it's an estate-
// level room of its own (OFFICE_AGENTS_KEY, below), present from day one regardless of org
// structure. "Unassigned" reading as a peer room made a correct system look broken (the owner's
// read on a company with zero departments). Nothing in this file currently produces an avatar that
// needs it; the room is only added to the scene if one ever does (see the `usesUnassigned` check).
export const OFFICE_UNASSIGNED_KEY = "unassigned";

export function deptRoomKey(deptId: string): string {
  return `dept-${deptId}`;
}

/** Builds the office scene for the active company. Every reader degrades to an empty list on its
 *  own failure (matching lib/pm.ts's own discipline) — a partial backend never throws the whole
 *  floor away. */
export async function getOfficeScene(u: string, t: string | null): Promise<OfficeScene> {
  const generatedAt = new Date().toISOString();
  if (!t) return { floors: [], avatars: [], events: [], generatedAt };

  const depts: DeptBrief[] = await listDepartmentBriefs(u, t).catch(() => [] as DeptBrief[]);
  const workspaces = await Promise.all(
    depts.map((d) => getDepartment(u, t, d.id).catch(() => null)),
  );
  const goals: AgentGoal[] = await getAgentGoals(u, t).catch(() => [] as AgentGoal[]);

  // O4 (req #5): resolve which of this tenant's goals has a genuinely OPEN run right now (no
  // endedAt yet) — only those goals get an `activeRunId`, which is the one thing that lets the
  // office canvas poll real run events and decide whether to show a working animation. A goal
  // that is "running" per its own status but whose run detail can't be read (elevated-only,
  // unavailable) simply gets no activeRunId — the avatar still renders, just without the
  // animation, which is the correct degrade (never fabricate the id).
  const activeGoals = goals.filter((g) => g.status === "queued" || g.status === "running");
  const activeRunByGoal = new Map<string, string>();
  if (activeGoals.length > 0) {
    const details = await Promise.all(activeGoals.map((g) => getAgentGoal(u, t, g.id).catch(() => null)));
    details.forEach((detail, i) => {
      // `Array.isArray` guard, not just truthiness: DEMO_MODE's catch-all route (and a genuinely
      // malformed backend response) can hand back `[]` in place of an object with a `.runs`
      // array — this DEGRADES to "no active run", never a crash (matches agentEvents-data.ts's
      // own `Array.isArray(res?.events)` discipline for exactly the same shape hazard).
      const runs = detail && Array.isArray(detail.runs) ? detail.runs : [];
      const openRun = [...runs]
        .filter((r) => r.endedAt == null)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
      if (openRun) activeRunByGoal.set(activeGoals[i].id, openRun.runId);
    });
  }

  const sortedDepts = [...depts].sort((a, b) => a.name.localeCompare(b.name));

  const avatars: OfficeAvatar[] = [];

  // ── Human employees — real org placements ──────────────────────────────────────────────────
  depts.forEach((d, di) => {
    const ws = workspaces[di];
    if (!ws) return;
    ws.people.forEach((p, pi) => {
      avatars.push({
        id: `human-${p.id}`,
        kind: "human",
        name: p.name,
        homeRoomKey: deptRoomKey(d.id),
        deskIndex: pi,
        recordKind: "person",
        recordId: p.id,
        recordLabel: `${p.name} — ${d.name}`,
        recordHref: `/departments/${d.id}`,
        note: `Real org placement in "${d.name}". This is a seat, not a live location — the office does not track where anyone actually is (plan §2).`,
      });
    });
  });

  // ── Internal agents — the always-present supervisor console + one seat per real goal ───────
  // ESTATE-level, not department-level (owner correction, 2026-08-23): agents exist from day one,
  // independent of org structure — a company with zero departments still has a running Supervisor.
  // They stand in Operations (OFFICE_AGENTS_KEY), a real room of its own, not "Unassigned" — that
  // key is reserved for a genuine binding failure, and "tenant-wide" is not a failure to bind.
  avatars.push({
    id: "agent-supervisor",
    kind: "agent",
    name: "Supervisor",
    homeRoomKey: OFFICE_AGENTS_KEY,
    deskIndex: 0,
    recordKind: "console",
    recordId: "agents-console",
    recordLabel: "Supervisor orchestrator — this company's goal tree",
    recordHref: "/agents",
    note: "The goal-tree orchestrator console. Agents are tenant-wide, not department-scoped, so it is housed in Operations by design — not a fallback, and not dependent on any department existing.",
  });
  goals.forEach((g, i) => {
    const activeRunId = activeRunByGoal.get(g.id);
    avatars.push({
      id: `agent-goal-${g.id}`,
      kind: "agent",
      name: g.agent ?? g.goal.slice(0, 24),
      homeRoomKey: OFFICE_AGENTS_KEY,
      deskIndex: i + 1,
      recordKind: "agent-goal",
      recordId: g.id,
      recordLabel: g.goal,
      recordHref: `/agents/goals/${g.id}`,
      note: activeRunId
        ? `Real agent goal, status "${g.status}", with a run currently in flight. The desk's working animation reflects that run's OWN recent events (O4) — it stops the moment the run goes quiet.`
        : `Real agent goal, status "${g.status}". Tenant-wide, not department-scoped, so it is housed in Operations by design.`,
      ...(activeRunId ? { activeRunId } : {}),
    });
  });

  // ── Automations — bound to the real systems consoles; no department tone by design ─────────
  avatars.push(
    {
      id: "automation-bot",
      kind: "automation",
      name: "WA/TG summariser",
      homeRoomKey: OFFICE_UTILITY_KEY,
      deskIndex: 0,
      recordKind: "system",
      recordId: "systems-bot",
      recordLabel: "WA/TG Bot console",
      recordHref: "/systems/bot",
      note: "Bound to the real WA/TG Bot admin console. It runs a fixed script and owns no decisions — no department tone.",
    },
    {
      id: "automation-workflow",
      kind: "automation",
      name: "n8n workflow relay",
      homeRoomKey: OFFICE_UTILITY_KEY,
      deskIndex: 1,
      recordKind: "system",
      recordId: "systems-automation",
      recordLabel: "Automation console",
      recordHref: "/systems/automation",
      note: "Bound to the real Automation systems console. It runs a fixed script and owns no decisions — no department tone.",
    },
  );

  // ── One external-agent demo seat — the airlock this represents is not built (O5) ───────────
  avatars.push({
    id: "external-demo",
    kind: "external",
    name: "Unnamed external agent",
    homeRoomKey: OFFICE_LOBBY_KEY,
    deskIndex: 0,
    recordKind: "fixture",
    recordId: "external-demo-1",
    recordLabel: "Demo fixture — no live airlock queue",
    assurance: "low",
    note: "DEMO FIXTURE. The airlock intent queue this seat represents (plan §4.3/O5) is not built — nothing here reflects a real external caller.",
  });

  // ── Movement — fixture events with real timestamps, skipped where the real data can't support
  // them (never invents a destination department that doesn't exist for this tenant). ─────────
  const events: OfficeMoveEvent[] = [];
  const webDev = sortedDepts.find((d) => d.name.toLowerCase().includes("web"));
  const seo = sortedDepts.find((d) => d.name.toLowerCase().includes("seo") && d.id !== webDev?.id);
  const now = Date.now();
  if (webDev) {
    events.push({
      id: "evt-1",
      avatarId: "agent-supervisor",
      fromRoomKey: OFFICE_AGENTS_KEY,
      toRoomKey: deptRoomKey(webDev.id),
      at: new Date(now - 6 * 60_000).toISOString(),
      reason: `Delegated a goal to ${webDev.name}`,
    });
    if (seo) {
      events.push({
        id: "evt-2",
        avatarId: "agent-supervisor",
        fromRoomKey: deptRoomKey(webDev.id),
        toRoomKey: deptRoomKey(seo.id),
        at: new Date(now - 2 * 60_000).toISOString(),
        reason: `Handed the follow-up to ${seo.name}`,
      });
    }
  }

  // ── Rooms — built last, now that every avatar's real homeRoomKey is known. Lobby, Operations
  // (agents) and Utility are ESTATE-level: present for every company regardless of org structure,
  // so a holding company with zero departments still reads as an inhabited office, not an empty
  // grid (owner correction, 2026-08-23). "Unassigned" is added only if some avatar genuinely needs
  // it — nothing here does, by construction, but a future binding failure gets a real diagnostic
  // room instead of silently landing nowhere. ──────────────────────────────────────────────────
  const usesUnassigned = avatars.some((a) => a.homeRoomKey === OFFICE_UNASSIGNED_KEY);
  // Occupancy counted from each avatar's HOME room, not its current resting room — a room's
  // footprint (req #3: "rooms will grow to accommodate employee") describes the department's real
  // seat count, not a snapshot of a mid-replay animation. deriveRoomOccupancy centralises this so
  // a room can never disagree with the avatar list that actually determines it.
  const occupancyByRoom = new Map<string, number>();
  for (const a of avatars) occupancyByRoom.set(a.homeRoomKey, (occupancyByRoom.get(a.homeRoomKey) ?? 0) + 1);
  const occupancyOf = (key: string) => occupancyByRoom.get(key) ?? 0;

  const roomInputs: OfficeRoomInput[] = [
    { key: OFFICE_LOBBY_KEY, label: "Lobby", kind: "lobby", boundTo: "Airlock queue — not built (O5)", occupantCount: occupancyOf(OFFICE_LOBBY_KEY) },
    { key: OFFICE_AGENTS_KEY, label: "Operations", kind: "agents", boundTo: "Tenant-wide agents — not department-scoped by design", occupantCount: occupancyOf(OFFICE_AGENTS_KEY) },
    ...sortedDepts.map((d) => ({
      key: deptRoomKey(d.id),
      label: d.name,
      kind: "department" as const,
      deptId: d.id,
      boundTo: `Org structure id: ${d.id}`,
      occupantCount: occupancyOf(deptRoomKey(d.id)),
    })),
    ...(usesUnassigned
      ? [{ key: OFFICE_UNASSIGNED_KEY, label: "Unassigned", kind: "unassigned" as const, boundTo: "Binding failure — a real avatar with no room to place it in", occupantCount: occupancyOf(OFFICE_UNASSIGNED_KEY) }]
      : []),
    { key: OFFICE_UTILITY_KEY, label: "Utility", kind: "utility" as const, boundTo: "No department — automations only", occupantCount: occupancyOf(OFFICE_UTILITY_KEY) },
  ];
  // ONE connected building (req #1): buildFloors packs this fixed room order into a corridor
  // spine, splitting onto further floors only if a single plate can't legibly hold them all
  // (req #2). Lobby stays first in roomInputs, so it always lands on floor 0 by construction.
  const floors = buildFloors(roomInputs);

  return { floors, avatars, events, generatedAt };
}
