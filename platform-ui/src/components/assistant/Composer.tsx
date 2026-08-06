"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AssistantToolAgent } from "@/lib/assistant";
import { refreshCapabilitiesAction, type SendMessageOpts } from "@/lib/assistantActions";

// ASST-07 — multiline composer. Enter sends, Shift+Enter inserts a newline (the universal chat-app
// convention, and the one aivory itself uses) — stated explicitly in the placeholder since there is
// no other affordance that would tell a keyboard-only user.
//
// T4 (ASST-23, §7.4) — the tools-mode affordance: before this ticket, NOTHING in the UI could send
// `mode:'tools'` at all (the design doc's own finding). `toolAgents` comes from the SAME
// `GET :t/assistant/capabilities` read `CapabilityCards` already uses (`refreshCapabilitiesAction`)
// — self-fetched here, once, on mount (this component persists across thread switches — see
// AssistantWorkspace — so there is no per-thread refetch to do), never a hand-maintained FE mirror
// of `ASSISTANT_AGENT_TOOLS`/`ASSISTANT_AGENT_WRITE_TOOLS`.
export function Composer({ canSend, streaming, onSend, onStop }: {
  /** False while a generation is pending for this thread (matches the backend's own "one active
   *  generation per thread" rule — see assistant.controller.ts's 409) OR while the thread itself
   *  hasn't loaded yet. */
  canSend: boolean;
  streaming: boolean;
  onSend: (text: string, opts?: SendMessageOpts) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [toolAgents, setToolAgents] = useState<AssistantToolAgent[]>([]);
  const [toolsMode, setToolsMode] = useState(false);
  const [agent, setAgent] = useState<string>("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await refreshCapabilitiesAction();
      if (!alive || !r.ok) return;
      setToolAgents(r.toolAgents);
      setAgent((cur) => cur || r.toolAgents[0]?.name || "");
    })();
    return () => {
      alive = false;
    };
  }, []);

  function submit() {
    const text = value.trim();
    if (!text || !canSend) return;
    onSend(text, toolsMode && agent ? { mode: "tools", agent } : { mode: "chat" });
    setValue("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <>
      <div className="asst-composer-toolbar">
        <label className="asst-composer-toggle">
          <input
            type="checkbox"
            checked={toolsMode}
            disabled={streaming || toolAgents.length === 0}
            onChange={(e) => setToolsMode(e.target.checked)}
          />
          Use tools
        </label>
        {toolsMode && (
          <>
            <label htmlFor="asst-composer-agent" className="asst-sr-only">Tool agent</label>
            <select
              id="asst-composer-agent"
              className="asst-composer__agent-select"
              value={agent}
              disabled={streaming}
              onChange={(e) => setAgent(e.target.value)}
            >
              {toolAgents.map((a) => (
                <option key={a.name} value={a.name}>{a.name}{a.writeTools.length > 0 ? " (can propose writes)" : ""}</option>
              ))}
            </select>
            <span className="asst-composer__mode-hint">
              This turn may call tools under your own permissions{toolAgents.find((a) => a.name === agent)?.writeTools.length ? " and may draft a write for you to confirm" : ""}.
            </span>
          </>
        )}
      </div>
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
    </>
  );
}
