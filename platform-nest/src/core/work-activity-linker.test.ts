// P1-04 — pure unit tests for the auto-link engine. No database, no skipIf: these must always run.
import { describe, it, expect } from "vitest";
import { deriveLinks, scanUuids, type LinkerContext } from "./work-activity-linker";

const TASK = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";
const OTHER_PERSON = "44444444-4444-4444-4444-444444444444";
const UNKNOWN = "99999999-9999-9999-9999-999999999999";

describe("work-activity-linker: scanUuids", () => {
  it("finds uuid-shaped substrings, de-duplicated and lowercased", () => {
    const text = `see ${TASK.toUpperCase()} and also ${TASK} again, plus ${PROJECT}`;
    expect(scanUuids(text).sort()).toEqual([PROJECT, TASK].sort());
  });

  it("returns [] for empty/undefined/no-match text", () => {
    expect(scanUuids(undefined)).toEqual([]);
    expect(scanUuids(null)).toEqual([]);
    expect(scanUuids("no ids here")).toEqual([]);
  });
});

describe("work-activity-linker: deriveLinks (a) structured hints", () => {
  it("payload.taskId/projectId/actorId each produce an EXACT link", () => {
    const links = deriveLinks({ source: "pm", payload: { taskId: TASK, projectId: PROJECT, actorId: ACTOR } });
    expect(links).toEqual(
      expect.arrayContaining([
        { targetKind: "pm_task", targetId: TASK, confidence: "exact", rule: "hint:taskId" },
        { targetKind: "project", targetId: PROJECT, confidence: "exact", rule: "hint:projectId" },
        { targetKind: "person", targetId: ACTOR, confidence: "exact", rule: "hint:actorId" },
      ]),
    );
  });

  it("ignores non-string hint values rather than throwing", () => {
    const links = deriveLinks({ source: "pm", payload: { taskId: 12345, projectId: null } as unknown as Record<string, unknown> });
    expect(links).toEqual([]);
  });

  it("no payload, no text -> no links", () => {
    expect(deriveLinks({ source: "manual" })).toEqual([]);
  });
});

describe("work-activity-linker: deriveLinks (b) uuid scan", () => {
  it("links a scanned uuid classified by ctx.knownIds as INFERRED", () => {
    const ctx: LinkerContext = { knownIds: { [PROJECT]: { kind: "project" } } };
    const links = deriveLinks({ source: "manual", text: `re-organized folder ${PROJECT}` }, ctx);
    expect(links).toEqual([{ targetKind: "project", targetId: PROJECT, confidence: "inferred", rule: "uuid_scan" }]);
  });

  it("never guesses at a uuid absent from ctx.knownIds", () => {
    const ctx: LinkerContext = { knownIds: { [PROJECT]: { kind: "project" } } };
    const links = deriveLinks({ source: "manual", text: `mentions ${UNKNOWN} only` }, ctx);
    expect(links).toEqual([]);
  });

  it("with no ctx.knownIds at all, scanned text produces no links (fail-closed, not a guess)", () => {
    const links = deriveLinks({ source: "manual", text: `mentions ${PROJECT}` });
    expect(links).toEqual([]);
  });

  it("an exact hint is never downgraded by a uuid-scan hit on the same id", () => {
    const ctx: LinkerContext = { knownIds: { [PROJECT]: { kind: "project" } } };
    const links = deriveLinks({ source: "pm", payload: { projectId: PROJECT }, text: `also see ${PROJECT}` }, ctx);
    expect(links.filter((l) => l.targetKind === "project" && l.targetId === PROJECT)).toEqual([
      { targetKind: "project", targetId: PROJECT, confidence: "exact", rule: "hint:projectId" },
    ]);
  });
});

describe("work-activity-linker: deriveLinks (c) derived chain", () => {
  it("task -> project -> department, chained from a bare taskId hint", () => {
    const ctx: LinkerContext = {
      taskProject: { [TASK]: PROJECT },
      projectDepartment: { [PROJECT]: "d-hr" },
    };
    const links = deriveLinks({ source: "pm", payload: { taskId: TASK } }, ctx);
    expect(links).toEqual(
      expect.arrayContaining([
        { targetKind: "pm_task", targetId: TASK, confidence: "exact", rule: "hint:taskId" },
        { targetKind: "project", targetId: PROJECT, confidence: "inferred", rule: "derived:task_project" },
        { targetKind: "department", targetId: "d-hr", confidence: "inferred", rule: "derived:project_department" },
      ]),
    );
  });

  it("is NULL-tolerant: a project with no department_id derives no department link (silent, not an error)", () => {
    const ctx: LinkerContext = {
      taskProject: { [TASK]: PROJECT },
      projectDepartment: { [PROJECT]: null },
    };
    const links = deriveLinks({ source: "pm", payload: { taskId: TASK } }, ctx);
    expect(links.some((l) => l.targetKind === "department")).toBe(false);
  });

  it("is NULL-tolerant: an unresolvable task (no ctx.taskProject entry) derives no project/department", () => {
    const links = deriveLinks({ source: "pm", payload: { taskId: TASK } }, {});
    expect(links).toEqual([{ targetKind: "pm_task", targetId: TASK, confidence: "exact", rule: "hint:taskId" }]);
  });

  it("actor -> person derivation maps through ctx.actorPerson", () => {
    const ctx: LinkerContext = { actorPerson: { [ACTOR]: OTHER_PERSON } };
    const links = deriveLinks({ source: "pm", payload: { actorId: ACTOR } }, ctx);
    expect(links).toEqual(
      expect.arrayContaining([
        { targetKind: "person", targetId: ACTOR, confidence: "exact", rule: "hint:actorId" },
        { targetKind: "person", targetId: OTHER_PERSON, confidence: "inferred", rule: "derived:actor_person" },
      ]),
    );
  });

  it("a project reached via uuid-scan still derives its department", () => {
    const ctx: LinkerContext = {
      knownIds: { [PROJECT]: { kind: "project" } },
      projectDepartment: { [PROJECT]: "d-eng" },
    };
    const links = deriveLinks({ source: "manual", text: `about ${PROJECT}` }, ctx);
    expect(links).toEqual(
      expect.arrayContaining([
        { targetKind: "project", targetId: PROJECT, confidence: "inferred", rule: "uuid_scan" },
        { targetKind: "department", targetId: "d-eng", confidence: "inferred", rule: "derived:project_department" },
      ]),
    );
  });

  it("full chain from a uuid-scanned task through project through department, plus actor->person", () => {
    const ctx: LinkerContext = {
      knownIds: { [TASK]: { kind: "pm_task" } },
      taskProject: { [TASK]: PROJECT },
      projectDepartment: { [PROJECT]: "d-web" },
      actorPerson: { [ACTOR]: OTHER_PERSON },
    };
    const links = deriveLinks({ source: "manual", payload: { actorId: ACTOR }, text: `worked on ${TASK}` }, ctx);
    const kinds = links.map((l) => `${l.targetKind}:${l.targetId}:${l.confidence}:${l.rule}`).sort();
    expect(kinds).toEqual(
      [
        `department:d-web:inferred:derived:project_department`,
        `person:${ACTOR}:exact:hint:actorId`,
        `person:${OTHER_PERSON}:inferred:derived:actor_person`,
        `pm_task:${TASK}:inferred:uuid_scan`,
        `project:${PROJECT}:inferred:derived:task_project`,
      ].sort(),
    );
  });

  it("an identity actorPerson map (person === user id, the common case) does not duplicate the link", () => {
    const ctx: LinkerContext = { actorPerson: { [ACTOR]: ACTOR } };
    const links = deriveLinks({ source: "pm", payload: { actorId: ACTOR } }, ctx);
    expect(links).toEqual([{ targetKind: "person", targetId: ACTOR, confidence: "exact", rule: "hint:actorId" }]);
  });
});
