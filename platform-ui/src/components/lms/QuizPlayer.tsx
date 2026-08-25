"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import type { QuizResult } from "@/lib/lmsLearnActions";

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** Present on purpose — see spec-redaction.ts. Written to be read AFTER an attempt. */
  explanation?: string;
}

/**
 * A quiz, worked entirely against the REDACTED spec — no `answer` field ever reaches this
 * component, because `getCourse` strips it server-side for every caller who is not authoring the
 * course. Grading happens on submit, server-side, against the backend's own copy of the spec.
 */
export function QuizPlayer({ activityId, courseId, questions, passThreshold, submit }: {
  activityId: string;
  courseId: string;
  questions: QuizQuestion[];
  passThreshold: string | null;
  submit: (formData: FormData) => Promise<QuizResult>;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [pending, startTransition] = useTransition();

  const allAnswered = questions.every((q) => answers[q.id] !== undefined);
  const locked = pending || (result?.ok ?? false);

  const onSubmit = () => {
    const fd = new FormData();
    fd.set("activityId", activityId);
    fd.set("courseId", courseId);
    fd.set("submission", JSON.stringify(answers));
    startTransition(async () => {
      setResult(await submit(fd));
    });
  };

  return (
    <Card title="Quiz">
      {questions.map((q, i) => {
        const verdict = result?.perQuestion?.find((p) => p.id === q.id);
        return (
          <div
            key={q.id}
            style={{
              marginBottom: 18, paddingBottom: 18,
              borderBottom: i < questions.length - 1 ? "0.5px solid var(--erp-hairline)" : undefined,
            }}
          >
            <p style={{ margin: "0 0 10px", font: "500 14px var(--font-body)" }}>{i + 1}. {q.prompt}</p>
            <div role="radiogroup" aria-label={q.prompt} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {q.options.map((opt, oi) => (
                <label key={oi} style={{ display: "flex", gap: 8, alignItems: "center", font: "400 13px var(--font-body)" }}>
                  <input
                    type="radio"
                    name={`q-${q.id}`}
                    checked={answers[q.id] === oi}
                    disabled={locked}
                    onChange={() => setAnswers((a) => ({ ...a, [q.id]: oi }))}
                  />
                  {opt}
                  {verdict && answers[q.id] === oi && (
                    <span style={{ color: `var(--status-${verdict.correct ? "ok" : "critical"}-fg)`, fontSize: 12 }}>
                      {verdict.correct ? "correct" : "incorrect"}
                    </span>
                  )}
                </label>
              ))}
            </div>
            {result?.ok && q.explanation && (
              <p style={{ margin: "10px 0 0", font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
                {q.explanation}
              </p>
            )}
          </div>
        );
      })}

      {!result?.ok && (
        <>
          {passThreshold && (
            <p style={{ margin: "0 0 12px", font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
              Pass mark: {passThreshold}
            </p>
          )}
          {result && !result.ok && (
            <p role="alert" style={{ margin: "0 0 12px", font: "400 13px var(--font-body)", color: "var(--status-danger-fg)" }}>
              {result.error}
            </p>
          )}
          <Button type="button" onClick={onSubmit} disabled={pending || !allAnswered}>
            {pending ? "Submitting…" : "Submit answers"}
          </Button>
        </>
      )}

      {result?.ok && (
        <div
          role="status"
          style={{
            padding: "12px 16px", borderRadius: 10,
            border: `1px solid var(--status-${result.passed ? "ok" : "critical"})`,
            background: `var(--status-${result.passed ? "ok" : "critical"}-bg)`,
            font: "400 14px/1.6 var(--font-body)",
          }}
        >
          <strong>{result.passed ? "Passed" : "Not yet"}</strong>
          {result.score !== null && result.score !== undefined && ` — score ${result.score}%`}
        </div>
      )}
    </Card>
  );
}
