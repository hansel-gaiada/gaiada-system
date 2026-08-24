// The cast. Loads roster.generated.json (see scripts/build-roster.sh) and turns it into the actors
// the scenarios drive.
//
// The distinction that matters most here is `placeholder`. Six of the 26 people in the live org tree
// are seed ACTORS deliberately retained by `retire-placeholder-hr.ts` — Ayu (Owner), Budi (PM),
// Citra (Design), Dewi (Copy), Eka (Client Lead), Gaiada Exec. They are useful precisely because
// approval flows need an approver, but they are not real employees. The simulation therefore:
//
//   * drives real staff for ordinary work, so the corpus describes what real people's work does, and
//   * uses placeholders ONLY where a scenario genuinely needs a role nobody real holds yet
//     (an approver, a client lead), and records that it did.
//
// Reporting "26 people worked today" would overstate the roster by 30%.
import { readFileSync } from "node:fs";
import { config } from "./config.js";
import type { Actor, ActorPath } from "./log.js";

export interface Person {
  name: string;
  userId: string;
  email: string;
  department: string;
  /** The verified WhatsApp external_id from identity_links, or null if this person cannot be driven
   *  over the OBO path at all. */
  whatsapp: string | null;
  placeholder: boolean;
  /** Cerbos role names granted to this person, from `user_roles`. The simulation needs these because
   *  authority is NOT uniform across the roster: `resource_pm_task.yaml` reserves create/delete and
   *  ownership changes for `company_admin`/`manager`, so a plain `member` gets a 403 on task create.
   *  Discovered the hard way — the first smoke run skipped three departments with "task create
   *  failed (403)" until the chain was rebuilt around who may actually raise work. */
  roles: string[];
}

interface RosterDoc {
  generatedAt: string;
  tenantId: string;
  people: Person[];
}

const rosterPath = process.env.SIM_ROSTER_FILE ?? new URL("../roster.generated.json", import.meta.url).pathname;

function loadRoster(): RosterDoc {
  let doc: RosterDoc;
  try {
    doc = JSON.parse(readFileSync(rosterPath, "utf8")) as RosterDoc;
  } catch (err) {
    throw new Error(
      `cannot read roster at ${rosterPath} (${(err as Error).message}). Run scripts/build-roster.sh first — the harness deliberately refuses to invent a cast.`,
    );
  }
  if (!Array.isArray(doc.people) || doc.people.length === 0) throw new Error("roster contains no people");
  if (doc.tenantId !== config.tenantId) {
    // A roster built for a different tenant would drive real names at the wrong company. Refuse
    // rather than proceed: this is the one mistake here that writes to the wrong estate.
    throw new Error(`roster tenant ${doc.tenantId} does not match configured tenant ${config.tenantId}`);
  }
  return doc;
}

export const roster = loadRoster();

/** Real staff who can actually be driven. Everything ordinary runs through these. */
export const staff: Person[] = roster.people.filter((p) => !p.placeholder && p.whatsapp);

/** Retained seed actors, used only where a scenario needs a role no real person holds. */
export const placeholders: Person[] = roster.people.filter((p) => p.placeholder);

export const departments: string[] = [...new Set(roster.people.map((p) => p.department))].sort();

export function staffIn(department: string): Person[] {
  return staff.filter((p) => p.department === department);
}

/** Can this person CREATE a pm_task? Mirrors resource_pm_task.yaml's management rule rather than
 *  guessing: create/delete/manage are `company_admin` or `manager` only. Kept as a predicate here so
 *  there is exactly one place to change if the policy changes. */
export function canRaiseWork(p: Person): boolean {
  return p.roles.includes("manager") || p.roles.includes("company_admin") || p.roles.includes("platform_admin");
}

/** The department's lead — the person who may raise and assign work there. */
export function leadOf(department: string): Person | undefined {
  const inDept = staffIn(department).filter(canRaiseWork);
  // Prefer a plain manager over the owner account: the owner holds platform_admin, which passes
  // every rule unconditionally, so using them would mask exactly the authorization differences this
  // simulation exists to surface.
  return inDept.find((p) => !p.roles.includes("platform_admin")) ?? inDept[0];
}

/** Someone in the department who does the work but cannot raise it — the ordinary employee case. */
export function doersIn(department: string): Person[] {
  return staffIn(department).filter((p) => !canRaiseWork(p));
}

/** A stable, non-random pick. Deliberately NOT Math.random: a run that picks the same people for
 *  the same tick index is reproducible, and reproducibility is what lets a finding be re-driven. */
export function pick<T>(items: readonly T[], n: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[n % items.length];
}

/** Two DIFFERENT people from the same department, for a handoff. Returns null when a department has
 *  only one person — Social Media has exactly one (Radit), and a "handoff" to yourself would be a
 *  fabricated interaction, so the scenario is skipped rather than faked. */
export function pairIn(department: string, n: number): { from: Person; to: Person } | null {
  const people = staffIn(department);
  if (people.length < 2) return null;
  const from = people[n % people.length]!;
  const to = people[(n + 1 + (n % (people.length - 1))) % people.length]!;
  if (from.userId === to.userId) return null;
  return { from, to };
}

/** Build the log Actor + the auth material for a person on a given identity path. */
export function actorFor(p: Person, path: ActorPath, agent?: string): { actor: Actor; obo?: { provider: string; externalId: string; agent?: string } } {
  const actor: Actor = { name: p.name, userId: p.userId, email: p.email, department: p.department, path };
  if (path === "human") {
    // The caller supplies the token; the OBO envelope is deliberately absent so a missing token
    // fails as an obvious 401 rather than silently falling back to the service path and producing a
    // corpus that claims a human did something a service actually did.
    return { actor };
  }
  if (!p.whatsapp) throw new Error(`${p.email} has no whatsapp link — cannot drive on the ${path} path`);
  return { actor, obo: { provider: "whatsapp", externalId: p.whatsapp, ...(agent ? { agent } : {}) } };
}

export function rosterSummary() {
  return {
    generatedAt: roster.generatedAt,
    total: roster.people.length,
    realStaff: staff.length,
    placeholders: placeholders.length,
    departments: departments.map((d) => ({ department: d, drivable: staffIn(d).length })),
  };
}
