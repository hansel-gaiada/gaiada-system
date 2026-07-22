// P1-04 auto-link engine. PURE function, no I/O — every DB lookup the rules need (which uuids in
// free text are real pm_task/project/person ids, a task's project, a project's department) is
// gathered by the CALLER (the controller boundary, work-activity.controller.ts) and handed in as
// a LinkerContext. This keeps the rule logic itself trivially unit-testable (see
// work-activity-linker.test.ts) and keeps every I/O concern (and its RLS/tenancy scoping) outside
// this file entirely.
//
// Rule order (LOCKED, do not reorder):
//   (a) structured hints — payload.taskId / payload.projectId / payload.actorId → 'exact'.
//   (b) uuid scan — free text (title/description/etc.) is scanned for uuid-shaped substrings;
//       ONLY those the caller could positively classify via ctx.knownIds are linked (never a
//       guess) → 'inferred', rule 'uuid_scan'.
//   (c) derived chain — whatever pm_task ended up linked (from a or b) derives its project
//       (ctx.taskProject); whatever project ended up linked derives its department_id
//       (ctx.projectDepartment, NULL-tolerant — no department is a normal, silent no-op, not an
//       error); whatever actor ended up linked derives its person target (ctx.actorPerson) →
//       'inferred', rule 'derived:*'.
// An exact link is never downgraded by a later inferred rule for the same (kind,id) pair.
//
// Phase-2 extension points (deliberately NOT implemented here — separate ticket):
//   - source === 'github': commit/PR → task via branch-name or PR-body task-id convention.
//   - source === 'google_drive': file → task/project via folder-path or doc-property convention.
// Each would add one more rule step below, gated on `input.source`, following the exact same
// "pure rule, I/O-free, caller resolves ids" shape as (b)/(c).

export type TargetKind = "pm_task" | "project" | "person" | "department";
export type Confidence = "exact" | "inferred";

export interface WorkActivityLink {
  targetKind: TargetKind;
  targetId: string;
  confidence: Confidence;
  rule: string;
}

/** Everything the pure engine needs to resolve uuid-scan + derived-chain links. Gathered by the
 *  caller via DB lookups BEFORE calling deriveLinks — this engine performs no I/O of its own. */
export interface LinkerContext {
  /** uuid (lowercased) -> its kind, for uuids found via the free-text scan (rule b). Only include
   *  uuids the caller positively identified as belonging to this tenant; an unrecognized scanned
   *  uuid is silently skipped (never guessed at). */
  knownIds?: Record<string, { kind: TargetKind }>;
  /** pm_task id -> its project id (rule c, task->project). */
  taskProject?: Record<string, string>;
  /** project id -> its department_id (org-node id), or omitted/undefined if the project has none
   *  (rule c, project->department; NULL-tolerant — no entry means no derived department link). */
  projectDepartment?: Record<string, string | null | undefined>;
  /** actor id -> the "person" target id it maps to (rule c, actor->person). In this schema a
   *  person IS a user id, so callers may pass an identity map; kept as an explicit seam so a
   *  future person/user split doesn't touch this engine. */
  actorPerson?: Record<string, string>;
}

export interface LinkerInput {
  source: string;
  /** Structured hints, read verbatim (no validation here — the controller validates shapes
   *  before this point). Only string values are honored; anything else is ignored. */
  payload?: Record<string, unknown>;
  /** Free text to scan for uuid mentions (e.g. title + description concatenated by the caller). */
  text?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Pure uuid-scan helper, exported so the controller boundary can run the SAME scan to collect
 *  candidate ids to resolve (via DB) into ctx.knownIds before calling deriveLinks. Case-insensitive
 *  match, de-duplicated, returned lowercased (canonical form used as the ctx.knownIds key). */
export function scanUuids(text: string | undefined | null): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(UUID_RE)) seen.add(m[0].toLowerCase());
  return [...seen];
}

function stringHint(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The auto-link engine. Deterministic, side-effect-free, unit-testable without a database. */
export function deriveLinks(input: LinkerInput, ctx: LinkerContext = {}): WorkActivityLink[] {
  const links = new Map<string, WorkActivityLink>(); // key `${kind}:${id}`; exact always wins

  const add = (kind: TargetKind, id: string | null | undefined, confidence: Confidence, rule: string) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    const existing = links.get(key);
    if (existing?.confidence === "exact") return; // never downgrade an exact link
    links.set(key, { targetKind: kind, targetId: id, confidence, rule });
  };

  const payload = input.payload ?? {};

  // (a) structured hints — exact.
  const taskHint = stringHint(payload, "taskId");
  const projectHint = stringHint(payload, "projectId");
  const actorHint = stringHint(payload, "actorId");
  add("pm_task", taskHint, "exact", "hint:taskId");
  add("project", projectHint, "exact", "hint:projectId");
  add("person", actorHint, "exact", "hint:actorId");

  // (b) uuid scan in free text — inferred, ONLY for uuids the caller could positively classify.
  if (input.text && ctx.knownIds) {
    for (const id of scanUuids(input.text)) {
      const known = ctx.knownIds[id];
      if (known) add(known.kind, id, "inferred", "uuid_scan");
    }
  }

  // (c) derived chain — task->project->department, actor->person. NULL-tolerant throughout: a
  // task/project/actor the caller couldn't resolve (or a project with no department) contributes
  // no derived link, never an error.
  const taskId = [...links.values()].find((l) => l.targetKind === "pm_task")?.targetId;
  if (taskId) {
    const projectFromTask = ctx.taskProject?.[taskId];
    add("project", projectFromTask, "inferred", "derived:task_project");
  }
  const projectId = [...links.values()].find((l) => l.targetKind === "project")?.targetId;
  if (projectId) {
    const dept = ctx.projectDepartment?.[projectId];
    add("department", dept ?? undefined, "inferred", "derived:project_department");
  }
  const actorId = [...links.values()].find((l) => l.targetKind === "person")?.targetId;
  if (actorId) {
    const person = ctx.actorPerson?.[actorId];
    add("person", person, "inferred", "derived:actor_person");
  }

  return [...links.values()];
}
