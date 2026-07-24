import type { AgentStep } from "@/lib/admin";
import { EmptyNote } from "@/components/systems/EmptyNote";

// CRITICAL (doc §3.4/§4, the aire injection lesson): a run transcript is
// UNTRUSTED model/tool output. It is rendered here as inert text ONLY —
// every step's `kind` and `detail` reaches the DOM exclusively as a plain
// React text child (auto-escaped by React; no HTML entities are ever
// interpreted). There is no dangerouslySetInnerHTML anywhere in this
// component, no markdown-to-HTML conversion, and no eval/Function/JSON-as-
// executable-UI of any kind — raw tool JSON, if a step's `detail` happens to
// contain it, is shown as a plain string inside a <pre>, never parsed or
// pretty-printed into interactive UI.
export function TranscriptView({ steps }: { steps: AgentStep[] }) {
  if (steps.length === 0) {
    return <EmptyNote>No transcript steps recorded for this run.</EmptyNote>;
  }

  return (
    <ol style={{ display: "grid", gap: 10, margin: 0, padding: 0, listStyle: "none" }}>
      {steps.map((step, i) => (
        <li
          key={i}
          style={{
            border: "1px solid rgba(26,25,22,.12)",
            borderRadius: 8,
            padding: "10px 14px",
          }}
        >
          {/* The "text chip" — kind only, from a closed {model|tool} union, never
              the untrusted part of the step. */}
          <span
            style={{
              display: "inline-block",
              font: "700 10px var(--font-body)",
              letterSpacing: ".04em",
              textTransform: "uppercase",
              color: step.kind === "tool" ? "var(--erp-accent)" : "rgba(26,25,22,.55)",
              marginBottom: 6,
            }}
          >
            {step.kind}
          </span>
          {/* The untrusted part: a plain text node inside <pre>, never innerHTML. */}
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              font: "400 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {step.detail}
          </pre>
        </li>
      ))}
    </ol>
  );
}
