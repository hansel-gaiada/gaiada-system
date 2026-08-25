// Redacting the grading key out of an activity spec before it reaches a learner.
//
// ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────────────────────
// `lms_activities.spec` is one jsonb column holding whatever the activity kind needs — prose for a
// `read`, a URL for a `watch`, QUESTIONS AND THEIR ANSWERS for a `quiz`. `GET /courses/:id`
// returned that column verbatim, and `resource_lms_course.yaml` names `member` in its read rule
// because training you cannot see is a support ticket. Put those two facts together and every
// employee could read the answer key to the mandatory assessment by opening the course they were
// assigned. Nothing would have looked wrong: the quiz still renders, the grader still grades, and
// the scores come back high — which is exactly what a working general track looks like.
//
// It could not bite before L2 because no quiz existed. L2 is the wave that creates them, so the
// fix lands with the content rather than after it.
//
// ── THE POSTURE ──────────────────────────────────────────────────────────────────────────────
// Redact by DEFAULT and unredact only for a caller who has been authorized to author or grade.
// The other way round — expose by default, hide when a flag is passed — puts every future activity
// kind one forgotten flag away from leaking, and new kinds are exactly what L4/L5/L6 add.
//
// Keys are stripped by NAME, recursively, rather than by knowing each kind's shape. A quiz spec
// nests answers inside `questions[]`, a lab spec will nest them inside test cases, and a shape-aware
// stripper silently passes anything it was not taught about.

/**
 * Field names that carry the grading key. Stripped wherever they appear, at any depth.
 *
 * `rubric` is deliberately ABSENT: a rubric tells a learner what good work looks like, which is
 * the point of a reviewed activity. `explanation` is absent for the same reason — it is written to
 * be read after an attempt, and hiding it would make a wrong answer un-learnable.
 */
export const GRADING_KEY_FIELDS = [
  // The WHOLE grading spec. A learner has no business reading the grader, and once labs exist this
  // is not a nicety: a Cyber lab's pass condition is "did you obtain the flag", so the flag itself
  // lives in a `stdoutMatches` pattern. Stripping only `answer` would have left the flag readable
  // in the course JSON — the exam handed out with the questions, one wave later than the quiz
  // version of the same mistake.
  "gradingSpec",
  "answer",
  "answers",
  "answerKey",
  "correct",
  "correctOption",
  "correctOptions",
  "solution",
  "expected",
  "expectedOutput",
  "assertions",
] as const;

const SENSITIVE = new Set<string>(GRADING_KEY_FIELDS);

/**
 * Deep-strip the grading key from an activity spec.
 *
 * Returns a NEW value; the input is never mutated (the caller usually holds a row object that
 * other code still reads). Arrays and nested objects are walked; scalars pass through.
 */
export function redactSpec(spec: unknown): { spec: unknown; redacted: boolean } {
  let redacted = false;

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE.has(k)) {
          redacted = true;
          continue;
        }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };

  return { spec: walk(spec), redacted };
}

/**
 * Whether an activity kind can carry a grading key at all.
 *
 * Used only to keep `specRedacted: false` honest on a `read` or `watch` — saying "redacted" about
 * a prose body would train people to ignore the flag.
 */
export function kindCanCarryAnswers(kind: string): boolean {
  return kind === "quiz" || kind === "lab" || kind === "scenario";
}
