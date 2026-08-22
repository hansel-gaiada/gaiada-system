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
import { getAgentGoals, type AgentGoal } from "./admin";
import {
  layoutRooms,
  type OfficeRoomInput,
  type OfficeAvatar,
  type OfficeMoveEvent,
  type OfficeScene,
} from "./office";

export const OFFICE_LOBBY_KEY = "lobby";
export const OFFICE_UTILITY_KEY = "utility";
export const OFFICE_UNASSIGNED_KEY = "unassigned";

export function deptRoomKey(deptId: string): string {
  return `dept-${deptId}`;
}

/** Builds the office scene for the active company. Every reader degrades to an empty list on its
 *  own failure (matching lib/pm.ts's own discipline) — a partial backend never throws the whole
 *  floor away. */
export async function getOfficeScene(u: string, t: string | null): Promise<OfficeScene> {
  const generatedAt = new Date().toISOString();
  if (!t) return { rooms: [], avatars: [], events: [], generatedAt };

  const depts: DeptBrief[] = await listDepartmentBriefs(u, t).catch(() => [] as DeptBrief[]);
  const workspaces = await Promise.all(
    depts.map((d) => getDepartment(u, t, d.id).catch(() => null)),
  );
  const goals: AgentGoal[] = await getAgentGoals(u, t).catch(() => [] as AgentGoal[]);

  const sortedDepts = [...depts].sort((a, b) => a.name.localeCompare(b.name));
  // Short on-canvas captions (the room header has room for one line, not a sentence) — the fuller
  // honesty text lives in each avatar's `note` and the page's own BackendPending banner, both
  // rendered off-canvas where a real line-wrap is available.
  const roomInputs: OfficeRoomInput[] = [
    { key: OFFICE_LOBBY_KEY, label: "Lobby", kind: "lobby", boundTo: "Airlock queue — not built (O5)" },
    ...sortedDepts.map((d) => ({
      key: deptRoomKey(d.id),
      label: d.name,
      kind: "department" as const,
      deptId: d.id,
      boundTo: `Org structure id: ${d.id}`,
    })),
    { key: OFFICE_UNASSIGNED_KEY, label: "Unassigned", kind: "unassigned" as const, boundTo: "No department binding" },
    { key: OFFICE_UTILITY_KEY, label: "Utility", kind: "utility" as const, boundTo: "No department — automations only" },
  ];
  const rooms = layoutRooms(roomInputs);

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
  avatars.push({
    id: "agent-supervisor",
    kind: "agent",
    name: "Supervisor",
    homeRoomKey: OFFICE_UNASSIGNED_KEY,
    deskIndex: 0,
    recordKind: "console",
    recordId: "agents-console",
    recordLabel: "Supervisor orchestrator — this company's goal tree",
    recordHref: "/agents",
    note: "The goal-tree orchestrator console. Goals are tenant-wide, not department-scoped, so it stands in Unassigned rather than a fabricated department seat.",
  });
  goals.forEach((g, i) => {
    avatars.push({
      id: `agent-goal-${g.id}`,
      kind: "agent",
      name: g.agent ?? g.goal.slice(0, 24),
      homeRoomKey: OFFICE_UNASSIGNED_KEY,
      deskIndex: i + 1,
      recordKind: "agent-goal",
      recordId: g.id,
      recordLabel: g.goal,
      recordHref: `/agents/goals/${g.id}`,
      note: `Real agent goal, status "${g.status}". No department binding exists for goals in this data model yet.`,
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
      fromRoomKey: OFFICE_UNASSIGNED_KEY,
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

  return { rooms, avatars, events, generatedAt };
}
