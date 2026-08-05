"use client";
import { useRef, useState, type KeyboardEvent } from "react";

// ASST-07 — multiline composer. Enter sends, Shift+Enter inserts a newline (the universal chat-app
// convention, and the one aivory itself uses) — stated explicitly in the placeholder since there is
// no other affordance that would tell a keyboard-only user.
export function Composer({ canSend, streaming, onSend, onStop }: {
  /** False while a generation is pending for this thread (matches the backend's own "one active
   *  generation per thread" rule — see assistant.controller.ts's 409) OR while the thread itself
   *  hasn't loaded yet. */
  canSend: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const text = value.trim();
    if (!text || !canSend) return;
    onSend(text);
    setValue("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="asst-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-label="Send a message"
    >
      <label htmlFor="asst-composer-input" className="asst-sr-only">
        Message the assistant
      </label>
      <textarea
        id="asst-composer-input"
        ref={taRef}
        className="asst-composer__input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        // ASST-22 — disabled (not just the Send button) while `canSend` is false for a reason other
        // than active streaming: a typable-but-silently-inert box is exactly the gap that let the
        // drawer's own thread-auto-create race (creating the page-context thread is a real network
        // round trip) swallow a fast Enter press with no feedback at all. Streaming keeps the box
        // enabled on purpose — Stop is still the composer's own action while a reply is in flight.
        disabled={!canSend && !streaming}
        placeholder={!canSend && !streaming ? "Preparing the assistant…" : "Message the assistant… (Enter to send, Shift+Enter for a new line)"}
        rows={3}
      />
      <div className="asst-composer__actions">
        {streaming ? (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!canSend || !value.trim()}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
