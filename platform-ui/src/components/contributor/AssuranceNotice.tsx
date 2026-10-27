import { ASSURANCE_NOTICE_BODY, ASSURANCE_NOTICE_TITLE } from "@/lib/contributorRouting";

// M5-W1f: what a contributor sees when the backend's fence answers 403 `assurance_high_required` (their sign-in has no real second factor yet).
// A refusal in words, never an empty list or a broken screen. It says nothing about the person's assignments (they are not hidden, just unread).
export function AssuranceNotice() {
  return (
    <section role="alert" data-testid="assurance-notice" style={{ display: "grid", gap: 10, maxWidth: 640, padding: "18px 20px", border: "1px solid var(--line)", borderRadius: 12, background: "var(--surface-card)" }}>
      <h1 style={{ margin: 0, font: "600 18px var(--font-display)", color: "var(--ink)" }}>{ASSURANCE_NOTICE_TITLE}</h1>
      <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--ink-muted)" }}>{ASSURANCE_NOTICE_BODY}</p>
    </section>
  );
}
