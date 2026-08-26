// The Office — a DEV-ONLY fixture scene for `/office-lab`.
//
// Why this exists: `/office` assembles its scene in `office-data.ts`, which is server-only and
// needs a live platform-nest (departments, agent goals, automation approvals). That makes the
// canvas — the part that actually animates — unopenable whenever the backend is down, which is the
// normal local state (the local stack is off; the server is truth). This module hands
// `OfficeCanvas` the same `OfficeScene` shape from pure literals so the RENDERER can be worked on
// and watched without any backend at all.
//
// This is NOT a demo of the product and must never be reachable from the app shell: `/office-lab`
// 404s outside development. Nothing here is real data and nothing here feeds `/office`.
import { buildFloors, type OfficeScene, type OfficeRoomInput, type OfficeAvatar, type OfficeMoveEvent } from "./office";

const ROOMS: OfficeRoomInput[] = [
  { key: "lobby", label: "Lobby", kind: "lobby", boundTo: "FIXTURE — not real", occupantCount: 2 },
  { key: "dept-webdev", label: "Web Development", kind: "department", deptId: "webdev", boundTo: "FIXTURE — not real", occupantCount: 6 },
  { key: "dept-creative", label: "Creative", kind: "department", deptId: "creative", boundTo: "FIXTURE — not real", occupantCount: 4 },
  { key: "dept-hr", label: "People & Culture", kind: "department", deptId: "hr", boundTo: "FIXTURE — not real", occupantCount: 3 },
  { key: "agents", label: "Agents", kind: "agents", boundTo: "FIXTURE — not real", occupantCount: 4 },
  { key: "utility", label: "Systems", kind: "utility", boundTo: "FIXTURE — not real", occupantCount: 3 },
];

const NOTE = "DEV FIXTURE — invented for /office-lab. Not a real person, agent or automation.";

function human(id: string, name: string, room: string, desk: number, busyMinsAgo?: number): OfficeAvatar {
  return {
    id, kind: "human", name, homeRoomKey: room, deskIndex: desk,
    recordKind: "Employee", recordId: id, recordLabel: name, note: NOTE,
    // A human never carries activeRunId (plan §3) — the fixture honours that rule too, so the
    // canvas exercises the SAME code path the real page does.
    ...(busyMinsAgo === undefined ? {} : { busyUntil: new Date(Date.now() - busyMinsAgo * 60_000).toISOString() }),
  };
}

function agent(id: string, name: string, desk: number, runId?: string): OfficeAvatar {
  return {
    id, kind: "agent", name, homeRoomKey: "agents", deskIndex: desk,
    recordKind: "Agent goal", recordId: id, recordLabel: name, note: NOTE,
    ...(runId ? { activeRunId: runId } : {}),
  };
}

function automation(id: string, name: string, desk: number, state: "executing" | "awaiting" | "failed" | "quiet"): OfficeAvatar {
  const base: OfficeAvatar = {
    id, kind: "automation", name, homeRoomKey: "utility", deskIndex: desk,
    recordKind: "Automation", recordId: id, recordLabel: name, note: NOTE,
  };
  if (state === "quiet") return base;
  return {
    ...base,
    automationSignal: {
      checked: true,
      pendingApproval: state === "awaiting",
      executionStatus: state === "executing" ? "executed" : state === "failed" ? "failed" : null,
      asOfMs: Date.now() - (state === "executing" ? 20_000 : 90_000),
      executionError: state === "failed" ? "hub_unreachable" : null,
    },
  };
}

/** A fresh fixture scene. Timestamps are computed relative to now so the recency-gated animations
 *  (working pulse, automation state) are actually exercised rather than always reading as stale. */
export function fixtureScene(): OfficeScene {
  const floors = buildFloors(ROOMS);

  const avatars: OfficeAvatar[] = [
    human("h1", "Amara Osei", "dept-webdev", 0, 2),
    human("h2", "Ben Halim", "dept-webdev", 1, 40),
    human("h3", "Chen Wu", "dept-webdev", 2),
    human("h4", "Dita Rahman", "dept-creative", 0, 5),
    human("h5", "Elias Vance", "dept-creative", 1),
    human("h6", "Farah Nasser", "dept-hr", 0, 12),
    human("h7", "Gita Prasad", "dept-hr", 1),
    human("h8", "Hana Yusuf", "lobby", 0),
    agent("a1", "Research agent", 0, "run-live-1"),
    agent("a2", "Report agent", 1, "run-live-2"),
    agent("a3", "Intake agent", 2),
    agent("a4", "Sweep agent", 3),
    automation("m1", "Nightly sync", 0, "executing"),
    automation("m2", "Invoice poster", 1, "awaiting"),
    automation("m3", "Backup verify", 2, "failed"),
  ];

  const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
  const events: OfficeMoveEvent[] = [
    { id: "e1", avatarId: "a1", fromRoomKey: "agents", toRoomKey: "dept-webdev", at: t(9), reason: "Delegated: draft the PRD" },
    { id: "e2", avatarId: "a2", fromRoomKey: "agents", toRoomKey: "dept-creative", at: t(6), reason: "Delegated: brief the shoot" },
    { id: "e3", avatarId: "a1", fromRoomKey: "dept-webdev", toRoomKey: "agents", at: t(3), reason: "Handed back to the estate" },
    { id: "e4", avatarId: "a4", fromRoomKey: "agents", toRoomKey: "dept-hr", at: t(1), reason: "Delegated: policy sweep" },
  ];

  return { floors, avatars, events, generatedAt: new Date().toISOString() };
}
