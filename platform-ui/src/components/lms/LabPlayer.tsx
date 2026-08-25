"use client";
import { useState, useTransition } from "react";
import { Card, Button } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import type { LabResult } from "@/lib/lmsLearnActions";
import "@/components/forms/forms.css";

export interface LabFile { path: string; content: string }

/**
 * A hands-on lab: editable starter files, submitted to `POST activities/:id/attempts`. The grade is
 * AUTHORITATIVE server-side — the runner evaluates the challenge's own grading spec, never
 * anything the browser asserts (see lab-dispatch.ts). If no runner is configured for this
 * deployment the backend 503s with a message meant to be read verbatim, and that is exactly what
 * `error` shows below — not a generic "something went wrong".
 */
export function LabPlayer({ activityId, courseId, brief, starter, submit }: {
  activityId: string;
  courseId: string;
  brief: string;
  starter: LabFile[];
  submit: (formData: FormData) => Promise<LabResult>;
}) {
  const [files, setFiles] = useState<LabFile[]>(
    starter.length > 0 ? starter : [{ path: "solution.js", content: "" }],
  );
  const [result, setResult] = useState<LabResult | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    const fd = new FormData();
    fd.set("activityId", activityId);
    fd.set("courseId", courseId);
    fd.set("files", JSON.stringify(files));
    startTransition(async () => {
      setResult(await submit(fd));
    });
  };

  return (
    <Card title="Hands-on lab">
      {brief ? (
        <p style={{ margin: "0 0 18px", font: "400 14px/1.7 var(--font-body)", color: "var(--erp-ink-60)", whiteSpace: "pre-wrap" }}>
          {brief}
        </p>
      ) : (
        <EmptyNote>No brief set for this lab yet.</EmptyNote>
      )}

      {files.map((f, i) => (
        <div key={f.path || i} style={{ marginBottom: 14 }}>
          <label className="lux-field">
            <span className="lux-field__label">{f.path || `file ${i + 1}`}</span>
            <textarea
              value={f.content}
              disabled={pending}
              onChange={(e) =>
                setFiles((fs) => fs.map((x, xi) => (xi === i ? { ...x, content: e.target.value } : x)))
              }
              className="lux-field__control lux-field__control--textarea"
              style={{ fontFamily: "ui-monospace, monospace", minHeight: 200 }}
              spellCheck={false}
            />
          </label>
        </div>
      ))}

      <Button type="button" onClick={onSubmit} disabled={pending}>
        {pending ? "Running…" : "Submit lab"}
      </Button>

      {result && !result.ok && (
        <p role="alert" style={{ marginTop: 14, font: "400 13px/1.6 var(--font-body)", color: "var(--status-danger-fg)" }}>
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div style={{ marginTop: 16 }}>
          <div
            role="status"
            style={{
              padding: "12px 16px", borderRadius: 10, marginBottom: 12,
              border: `1px solid var(--status-${result.passed ? "ok" : "critical"})`,
              background: `var(--status-${result.passed ? "ok" : "critical"}-bg)`,
              font: "400 14px/1.6 var(--font-body)",
            }}
          >
            <strong>{result.passed ? "Passed" : "Not yet"}</strong>
            {result.score !== null && result.score !== undefined && ` — score ${result.score}%`}
          </div>
          {result.checks && result.checks.length > 0 && (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
              {result.checks.map((c, i) => (
                <li key={i} style={{ font: "400 13px var(--font-body)", color: `var(--status-${c.passed ? "ok" : "danger"}-fg)` }}>
                  {c.passed ? "✓" : "✗"} {c.describe}
                  {c.detail && (
                    <div style={{ marginTop: 2, font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>{c.detail}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.note && (
            <p style={{ marginTop: 10, font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>{result.note}</p>
          )}
        </div>
      )}
    </Card>
  );
}
