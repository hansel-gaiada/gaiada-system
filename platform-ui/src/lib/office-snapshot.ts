import "server-only";
// Loads a REAL `OfficeScene` captured off the live server, for `/office-lab` only.
//
// Why this exists: `lib/office-fixture.ts` renders invented data, which is enough to work on the
// renderer but hides everything that only real data reveals — how many rooms a tenant actually
// has, how lopsided their occupancy is, how many agent goals accumulate. Pointing the lab at a
// captured snapshot puts the real SHAPE on screen without needing a live session in the browser.
//
// The snapshot file is NEVER committed: it contains real employees' names. It lives outside the
// repo and is passed in by absolute path via OFFICE_SNAPSHOT, so there is nothing here for a
// commit to pick up by accident.
import { readFile } from "node:fs/promises";
import { buildFloors, type OfficeScene, type OfficeAvatar, type OfficeRoomInput } from "./office";

interface SnapshotFile {
  rooms: OfficeRoomInput[];
  avatars: OfficeAvatar[];
}

/** Reads the snapshot named by OFFICE_SNAPSHOT, or null when the variable is unset. Returns null
 *  (never throws) on a missing or malformed file — the lab then falls back to the fixture, which
 *  is the honest degrade: a lab that renders nothing is harder to diagnose than one that says
 *  plainly it is showing invented data. */
export async function loadSnapshotScene(): Promise<OfficeScene | null> {
  const p = process.env.OFFICE_SNAPSHOT;
  if (!p) return null;
  try {
    const parsed = JSON.parse(await readFile(p, "utf8")) as SnapshotFile;
    if (!Array.isArray(parsed.rooms) || !Array.isArray(parsed.avatars)) return null;
    return {
      floors: buildFloors(parsed.rooms),
      avatars: parsed.avatars,
      // A snapshot carries no movement: `agent_run_events` is the only thing that produces a real
      // move, and O0 is not built. Inventing events here would be exactly the dishonesty the
      // office plan §3 rules out — an empty list correctly disables the replay button.
      events: [],
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
