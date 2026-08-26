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
import { platformFetch } from "./platform";
import { getAgentGoals, getAgentGoal, type AgentGoal } from "./admin";
import { listAutomationApprovals, type AutomationApproval } from "./automationApprovals";
import {
  buildFloors,
  groupAgentSeats,
  describeAgentSeat,
  type OfficeRoomInput,
  type OfficeAvatar,
  type OfficeMoveEvent,
  type OfficeScene,
  type AutomationSignal,
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

/** SIM-01 — one row of the tenant's real recorded activity. Only the four fields the office needs;
 *  the endpoint returns more, and reading only what is used keeps this immune to the rest changing. */
interface OfficeActivityRow {
  actor_id?: string | null;
  verb?: string;
  target_entity_type?: string;
  target_entity_id?: string | null;
  occurred_at?: string;
}

/** How long one recorded action keeps a desk looking busy. Matched to the agent feed's own 45s
 *  freshness rule times four: an agent emits an event every few seconds while it works, whereas a
 *  person saves something every few minutes, so the same window would blink a human desk off
 *  between two genuinely continuous pieces of work. Three minutes reads as "at their desk"; much
 *  longer and the floor stops distinguishing today's work from this morning's. */
const HUMAN_BUSY_WINDOW_MS = 3 * 60_000;

/** SIM-01 — the humans' activity feed.
 *
 *  Reads the SAME `/api/:t/activity` stream the audit console already reads, rather than adding a
 *  new endpoint: every write in the platform funnels through `writeActivity`, so this is already the
 *  authoritative record of who did something and when. Returns a map of userId -> most recent action.
 *
 *  Degrades to an empty map on ANY failure, matching this file's existing discipline: a floor with
 *  still desks is a correct floor when the feed is unavailable. What it must never do is invent
 *  activity — a fabricated busy desk is a claim about a named person's working hours. */
async function readActivity(u: string, t: string): Promise<{ byActor: Map<string, OfficeActivityRow>; rows: OfficeActivityRow[] }> {
  const rows = await platformFetch<OfficeActivityRow[]>(`/api/${t}/activity?limit=100`, u).catch(() => [] as OfficeActivityRow[]);
  const list = Array.isArray(rows) ? rows : [];
  const byActor = new Map<string, OfficeActivityRow>();
  for (const r of list) {
    // The endpoint orders newest-first, so the FIRST row seen for an actor is their latest. Relying
    // on that rather than comparing timestamps keeps this correct even for rows sharing a timestamp.
    if (!r.actor_id) continue;
    if (!byActor.has(r.actor_id)) byActor.set(r.actor_id, r);
  }
  return { byActor, rows: list };
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
  // SIM-01 — the human activity feed, read once for the whole scene (never per avatar).
  const activity = await readActivity(u, t);
  const nowMs = Date.now();

  // ── Real automation execution signal (2026-08-24) — driven by automation_approvals, the SAME
  // reader the department console's "Waiting on me" rail and the unified approvals inbox already
  // use. `null` (as opposed to `[]`) is the deliberate signal that THIS particular read genuinely
  // failed — `listAutomationApprovals` already degrades a 403/404 to `[]` internally (a legitimate
  // "nothing visible", the same house rule every lib/*.ts reader follows), so a `null` here means
  // something worse actually broke. `autoChecked` folds that into ONE honest flag: false only when
  // a real read failure means we cannot make ANY claim about an automation's state, never when the
  // tenant simply has zero rows. */
  const [pendingAuto, approvedAuto, rejectedAuto] = await Promise.all([
    listAutomationApprovals(u, t, { status: "pending" }).catch(() => null),
    listAutomationApprovals(u, t, { status: "approved" }).catch(() => null),
    listAutomationApprovals(u, t, { status: "rejected" }).catch(() => null),
  ]);
  const autoChecked = pendingAuto !== null && approvedAuto !== null && rejectedAuto !== null;
  // `origin === "automation"` only — an "agent" origin row is a suspended AGENT write (already
  // surfaced through that agent's own run events/approval_wait emote above), never an automation's.
  const pendingAutoRows = (pendingAuto ?? []).filter((r) => r.origin === "automation");
  const decidedAutoRows = [...(approvedAuto ?? []), ...(rejectedAuto ?? [])].filter((r) => r.origin === "automation");
  // One real desk per distinct real workflow_id — more honest than folding every automation-origin
  // row onto one umbrella avatar, which would let two genuinely different workflows (one waiting on
  // a human, one mid-execution) silently overwrite each other's real state on a single desk.
  const workflowIds = [...new Set([...pendingAutoRows, ...decidedAutoRows].map((r) => r.workflow_id))].sort();

  function automationSignalFor(workflowId: string): AutomationSignal {
    const pendingApproval = pendingAutoRows.some((r) => r.workflow_id === workflowId);
    if (!autoChecked) {
      return { checked: false, pendingApproval, executionStatus: null, asOfMs: null, executionError: null };
    }
    const decided = decidedAutoRows
      .filter((r) => r.workflow_id === workflowId)
      .sort((a, b) => Date.parse(b.decided_at ?? b.created_at) - Date.parse(a.decided_at ?? a.created_at))[0] as
      AutomationApproval | undefined;
    const executionStatus = decided?.execution_status ?? null;
    const executedAtMs = decided?.executed_at ? Date.parse(decided.executed_at) : null;
    // A failure can occur before an execution ever reaches `executed_at` (e.g. "hub_unreachable"
    // never got that far — see the demo fixture aa-4) — `decided_at` is the real timestamp closest
    // to when the failure became known, so it anchors freshness for THAT case only. Every other
    // status needs a genuine `executed_at` to count as "recently active" — never invents one.
    const failedAtMs = executionStatus === "failed" && decided?.decided_at ? Date.parse(decided.decided_at) : null;
    const asOfMs = executedAtMs ?? failedAtMs;
    return {
      checked: true,
      pendingApproval,
      executionStatus,
      asOfMs: asOfMs != null && !Number.isNaN(asOfMs) ? asOfMs : null,
      executionError: decided?.execution_error ?? null,
    };
  }

  function humanizeWorkflowId(id: string): string {
    return id.replace(/^wf-/, "").replace(/[-_]+/g, " ");
  }

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
      // SIM-01 — a REAL recorded action within the window makes this desk read as busy. `last` is
      // this person's most recent row from the tenant's own activity stream; absent means the ERP
      // has simply not recorded anything for them lately, which is NOT the same as idle.
      const last = activity.byActor.get(p.id);
      const lastMs = last?.occurred_at ? Date.parse(last.occurred_at) : NaN;
      // `Number.isFinite` guard, not truthiness: `Date.parse` of a malformed timestamp is NaN, and
      // NaN + window is NaN, which would produce an `Invalid Date` ISO string and throw on toISOString.
      const busyUntil =
        Number.isFinite(lastMs) && nowMs - lastMs < HUMAN_BUSY_WINDOW_MS
          ? new Date(lastMs + HUMAN_BUSY_WINDOW_MS).toISOString()
          : undefined;
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
        note:
          `Real org placement in "${d.name}". This is a seat, not a live location — the office does not track where anyone actually is (plan §2).` +
          (busyUntil
            ? ` Their desk is active because the ERP recorded "${last?.verb ?? "an action"}" from them at ${last?.occurred_at}. It reflects RECORDED WORK ONLY — not presence, and not hours.`
            : " No recorded action in the last few minutes. That means the ERP has logged nothing recently, NOT that this person is idle."),
        ...(busyUntil ? { busyUntil } : {}),
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
  // ONE desk per AGENT, not per goal. Per-goal desks were unbounded — the live agency tenant had
  // 50 goals from a single agent, which rendered 51 Operations desks against 8 in the largest real
  // department, all sharing one name, and growing with every goal ever run. `groupAgentSeats`
  // (office.ts) carries the full reasoning; the short version is that an agent is the worker and a
  // goal is the work, and humans are already modelled that way.
  groupAgentSeats(goals, activeRunByGoal).forEach((seat, i) => {
    avatars.push({
      id: `agent-${seat.key}`,
      kind: "agent",
      name: seat.name,
      homeRoomKey: OFFICE_AGENTS_KEY,
      deskIndex: i + 1,
      recordKind: "agent",
      recordId: seat.key,
      recordLabel: describeAgentSeat(seat),
      // Links at the in-flight goal when there is one, else any of this agent's goals — from
      // there the goal tree is the readable place to see the rest.
      recordHref: `/agents/goals/${seat.linkGoalId}`,
      note: seat.activeRunId
        ? `Real agent. ${describeAgentSeat(seat)}. One run is in flight now — the desk's working animation reflects that run's OWN recent events (O4) and stops the moment it goes quiet.`
        : `Real agent. ${describeAgentSeat(seat)}. No run is in flight, so this desk is still — that means nothing is RUNNING, not that the agent is idle or broken.`,
      ...(seat.activeRunId ? { activeRunId: seat.activeRunId } : {}),
    });
  });

  // ── Automations — bound to the real systems consoles; ORIGINALLY reasoned "no department tone
  // by design" (kept below, not deleted — see office.ts's `automationColorToken` for the owner
  // override that now consciously supersedes it: an automation DOES get a department tone once one
  // genuinely applies, settable colour first, department second, grey only when truly unbound).
  // Neither seat below has a real department binding today, so both still correctly render grey —
  // that is the fallback chain doing its job, not the override going unused. ───────────────────────
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
      note: "Bound to the real WA/TG Bot admin console. It runs a fixed script and owns no decisions — no department tone. Not gated through automation-approvals, so it carries no execution signal at all (static, like before this feature) — never a fabricated 'unknown'.",
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

  // ── One real desk per distinct automation-origin workflow_id (2026-08-24) — this is the honest
  // signal the two console seats above don't carry: a genuinely pending, executing or failed real
  // row, never fabricated. `deptId` is left unset for every one of these (see the block comment
  // above) — none has a real department binding yet, so grey is the correct, honest result of the
  // fallback chain, not a gap in it. ──────────────────────────────────────────────────────────────
  workflowIds.forEach((wfId, i) => {
    avatars.push({
      id: `automation-workflow-${wfId}`,
      kind: "automation",
      name: humanizeWorkflowId(wfId),
      homeRoomKey: OFFICE_UTILITY_KEY,
      deskIndex: 2 + i,
      recordKind: "automation-workflow",
      recordId: wfId,
      recordLabel: `Automation workflow: ${wfId}`,
      recordHref: "/systems/automation",
      note: "Real automation workflow, tracked via the automation-approvals inbox (the same reader behind the department console's \"Waiting on me\" rail). Its desk animation reflects that workflow's own real pending/decided rows — never a fabricated state.",
      automationSignal: automationSignalFor(wfId),
    });
  });

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

  // ── Movement — DERIVED FROM REAL HANDOFFS (SIM-01, 2026-08-24) ─────────────────────────────────
  // Previously two hardcoded fixture events. Now: when two DIFFERENT people both act on the SAME
  // entity, the work changed hands, and that is a real event with a real timestamp and two real
  // names. The avatar that acted FIRST walks to the second person's room, which is the direction a
  // handoff actually travels — the person finishing brings it over.
  //
  // WHAT THIS IS NOT: it is not presence and not a claim that anyone physically moved. It is a
  // visualisation of a recorded handoff, and the event's own `reason` says which two records it was
  // derived from so the detail panel can never imply more than the data supports.
  //
  // Bounded — but far less tightly than it was (2026-08-24). The old bound was 4, and its stated
  // reason was that "the replay animates each event IN TURN". That is no longer true: the scheduler
  // in lib/office.ts now gives each avatar its own lane and plays different people concurrently, so
  // twelve handoffs between eight people is one busy moment rather than nineteen seconds of queue.
  // The cap was compensating for the scheduler, not for the data. What still needs bounding is the
  // number of DISTINCT figures crossing the floor at once, which is a legibility limit, not a
  // playback-length one.
  const events: OfficeMoveEvent[] = [];
  // Humans AND agents (2026-08-24). Agents were excluded when this only drew human handoffs, and
  // that silently discarded the delegation the office was originally built to show: an agent
  // picking work up in Operations and carrying it to the department that owns it. An agent has a
  // real seat and a real room, so it can be walked from one to the other on exactly the same
  // evidence as a person — two actors on one record. Automations stay OUT: they are bound to a
  // desk, they own no decisions, and a robot that walks work to a department would imply it chose
  // to, which is a claim the row underneath does not make.
  const homeRoomByUser = new Map<string, { avatarId: string; roomKey: string; name: string }>();
  for (const a of avatars) {
    const eligible = (a.kind === "human" && a.recordKind === "person") || a.kind === "agent";
    if (eligible) {
      homeRoomByUser.set(a.recordId, { avatarId: a.id, roomKey: a.homeRoomKey, name: a.name });
    }
  }

  // Group the activity rows by the entity they touched, preserving the newest-first order the
  // endpoint returns.
  const byEntity = new Map<string, OfficeActivityRow[]>();
  for (const r of activity.rows) {
    if (!r.target_entity_id || !r.actor_id) continue;
    const key = `${r.target_entity_type ?? "?"}:${r.target_entity_id}`;
    const list = byEntity.get(key);
    if (list) list.push(r);
    else byEntity.set(key, [r]);
  }

  const MAX_DERIVED_EVENTS = 14;
  for (const [, rows] of byEntity) {
    if (events.length >= MAX_DERIVED_EVENTS) break;
    if (rows.length < 2) continue;
    // Newest first, so `rows[0]` is the LATER actor (the receiver) and the next distinct actor
    // below it is the EARLIER one (the sender).
    const receiver = rows[0]!;
    const sender = rows.find((r) => r.actor_id && r.actor_id !== receiver.actor_id);
    if (!sender || !receiver.actor_id || !sender.actor_id) continue;

    const from = homeRoomByUser.get(sender.actor_id);
    const to = homeRoomByUser.get(receiver.actor_id);
    // Both must be people the office actually draws. An activity by someone outside the org tree
    // (an automation principal, a client contact) has no seat, and inventing one would put a
    // stranger on the floor.
    if (!from || !to || from.roomKey === to.roomKey) continue;

    events.push({
      id: `move-${sender.actor_id.slice(0, 8)}-${receiver.actor_id.slice(0, 8)}`,
      avatarId: from.avatarId,
      fromRoomKey: from.roomKey,
      toRoomKey: to.roomKey,
      at: sender.occurred_at ?? new Date(nowMs).toISOString(),
      reason: `${from.name} handed work to ${to.name} — derived from two real ${receiver.target_entity_type ?? "record"} actions, not from any location tracking`,
    });
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
