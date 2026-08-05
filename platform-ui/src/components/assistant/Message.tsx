import { isPendingMessage, humanizeErrorKind, type AssistantMessage } from "@/lib/assistant";
import { renderMarkdownLite } from "./markdownLite";

// ASST-07 — one message bubble. `streaming`/`liveText` are set ONLY for the single row currently
// being generated in THIS tab (see AssistantWorkspace) — every other row renders its persisted
// `content` straight from the last server fetch, which is what makes "refresh restores the exact
// transcript" true: there is no separate "history" rendering path, the same component draws both.
export function Message({ message, streaming, liveText }: {
  message: AssistantMessage;
  streaming?: boolean;
  liveText?: string;
}) {
  const isUser = message.role === "user";
  const pending = isPendingMessage(message);
  const bodyText = streaming ? liveText ?? "" : message.content ?? "";
  const failed = !streaming && !!message.errorKind && message.errorKind !== "stopped";
  const stopped = !streaming && message.errorKind === "stopped";

  return (
    <article className={`asst-msg asst-msg--${isUser ? "user" : "assistant"}`}>
      <div className="asst-msg__role">{isUser ? "You" : "Assistant"}</div>
      <div className="asst-msg__bubble">
        {pending && !streaming ? (
          <p className="asst-msg__meta">Generating a reply…</p>
        ) : bodyText ? (
          <div className="asst-msg__body">
            {renderMarkdownLite(bodyText)}
            {streaming && <span className="asst-cursor" aria-hidden="true" />}
          </div>
        ) : (
          !failed && !stopped && <p className="asst-msg__meta">(empty reply)</p>
        )}
        {stopped && <p className="asst-msg__meta asst-msg__meta--stopped">Stopped{bodyText ? "." : " before any reply."}</p>}
        {failed && <p className="asst-msg__error">{humanizeErrorKind(message.errorKind as string)}</p>}
      </div>
    </article>
  );
}
