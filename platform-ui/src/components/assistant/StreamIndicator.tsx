import { humanizeErrorKind, type StreamState } from "@/lib/assistant";

// ASST-07 — the ONE `aria-live` region for the whole streaming flow. Deliberately NOT wired to
// announce every token: a screen-reader user does not want every few characters of a fast reply
// read aloud (that would be true of the message bubble itself, which is why it is plain markup, not
// `aria-live`). This status line changes rarely — thinking -> responding -> finished/stopped/error —
// which is exactly the granularity `aria-live="polite"` is for.
export function StreamIndicator({ state }: { state: StreamState }) {
  if (state.status === "idle") return null;

  const label =
    state.status === "streaming"
      ? state.text === "" ? "Assistant is thinking…" : "Assistant is responding…"
      : state.status === "done"
        ? "Assistant finished responding."
        : state.status === "stopped"
          ? "Stopped."
          : `Assistant reply failed: ${humanizeErrorKind(state.error?.kind ?? "unknown")}`;

  return (
    <div className="asst-stream-status" role="status" aria-live="polite">
      {state.status === "streaming" && state.text === "" && (
        <span className="asst-thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      )}
      <span>{label}</span>
    </div>
  );
}
