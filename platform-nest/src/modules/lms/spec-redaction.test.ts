// Guards the answer-key redaction. Pure — no database, no Cerbos, so it runs everywhere and can
// never be one of the suites that silently skips.
//
// The defect being guarded: `GET /courses/:id` returned `lms_activities.spec` verbatim, and
// resource_lms_course.yaml names `member` in its read rule on purpose. Every employee could read
// the answer key to their own mandatory assessment, and the result — high scores on the general
// track — is indistinguishable from the training working.
import { describe, it, expect } from "vitest";
import { redactSpec, kindCanCarryAnswers, GRADING_KEY_FIELDS } from "./spec-redaction";

describe("redactSpec", () => {
  it("strips the answer out of every question, at depth, and says it did", () => {
    const spec = {
      instructions: "Five questions.",
      questions: [
        { id: "q1", prompt: "Where do you file leave?", options: ["HR console", "Me → Leave"], answer: 1,
          explanation: "Me → Leave is your own surface." },
        { id: "q2", prompt: "Second one", options: ["a", "b"], answer: 0 },
      ],
    };
    const { spec: out, redacted } = redactSpec(spec);
    expect(redacted).toBe(true);
    const qs = (out as { questions: Record<string, unknown>[] }).questions;
    expect(qs).toHaveLength(2);
    for (const q of qs) expect(q).not.toHaveProperty("answer");
    // The parts a learner NEEDS survive. A redaction that also removed the prompt would be safe
    // and useless, and the failure would look like "the quiz is broken" rather than "over-redacted".
    expect(qs[0].prompt).toBe("Where do you file leave?");
    expect(qs[0].options).toEqual(["HR console", "Me → Leave"]);
    // Kept ON PURPOSE: an explanation is written to be read after an attempt, and hiding it makes
    // a wrong answer un-learnable.
    expect(qs[0].explanation).toBe("Me → Leave is your own surface.");
  });

  it("does not mutate the input", () => {
    const spec = { questions: [{ id: "q1", answer: 3 }] };
    redactSpec(spec);
    expect(spec.questions[0].answer).toBe(3);
  });

  it("strips every named grading-key field, wherever it is nested", () => {
    // One case per field, each buried a different depth, because the stripper works by NAME rather
    // than by knowing a shape — and the whole point of that choice is the kinds L5/L6 add later.
    for (const field of GRADING_KEY_FIELDS) {
      const spec = { a: { b: [{ c: { [field]: "secret", keep: "visible" } }] } };
      const { spec: out, redacted } = redactSpec(spec);
      expect(redacted, `field ${field} should be reported redacted`).toBe(true);
      const leaf = (out as { a: { b: { c: Record<string, unknown> }[] } }).a.b[0].c;
      expect(leaf, `field ${field} should be stripped`).not.toHaveProperty(field);
      expect(leaf.keep).toBe("visible");
    }
  });

  it("strips the WHOLE gradingSpec — a learner must not read the grader", () => {
    // Once labs exist this is not a nicety. A Cyber lab's pass condition is "did you obtain the
    // flag", so the flag lives in a stdoutMatches pattern; leaving gradingSpec readable would hand
    // out the exam with the questions.
    const spec = {
      brief: "Break the target and recover the flag.",
      gradingSpec: { checks: [{ kind: "stdoutMatches", pattern: "FLAG\{[a-f0-9]+\}" }] },
    };
    const { spec: out, redacted } = redactSpec(spec);
    expect(redacted).toBe(true);
    expect(out).not.toHaveProperty("gradingSpec");
    expect(JSON.stringify(out)).not.toContain("FLAG");
    // The brief survives — it is what the learner is supposed to read.
    expect((out as { brief: string }).brief).toContain("Break the target");
  });

  it("leaves a rubric alone — it tells the learner what good work looks like", () => {
    const spec = { rubric: ["clear hierarchy", "consistent spacing"], answer: "x" };
    const { spec: out } = redactSpec(spec);
    expect((out as { rubric: string[] }).rubric).toEqual(["clear hierarchy", "consistent spacing"]);
    expect(out).not.toHaveProperty("answer");
  });

  it("reports redacted=false for a spec that never carried a key", () => {
    const { spec: out, redacted } = redactSpec({ body: "Some prose about the sidebar." });
    expect(redacted).toBe(false);
    expect(out).toEqual({ body: "Some prose about the sidebar." });
  });

  it("passes scalars, arrays and null through unharmed", () => {
    expect(redactSpec(null).spec).toBeNull();
    expect(redactSpec("text").spec).toBe("text");
    expect(redactSpec([1, 2, 3]).spec).toEqual([1, 2, 3]);
  });
});

describe("kindCanCarryAnswers", () => {
  it("is true for the graded kinds and false for prose", () => {
    expect(kindCanCarryAnswers("quiz")).toBe(true);
    expect(kindCanCarryAnswers("lab")).toBe(true);
    expect(kindCanCarryAnswers("scenario")).toBe(true);
    // Saying "redacted" about a prose body would train people to ignore the flag.
    expect(kindCanCarryAnswers("read")).toBe(false);
    expect(kindCanCarryAnswers("watch")).toBe(false);
  });
});
