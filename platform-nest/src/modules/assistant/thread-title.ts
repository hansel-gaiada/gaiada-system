// Server-side thread-title derivation — the AUTHORITATIVE fix for the owner complaint "every
// thread in the sidebar reads 'New chat'". The FE-only fix that shipped in alpha-01.024.0063a
// (AssistantWorkspace.tsx's `handleSend`) only ever fires when `messages.length === 0`, which is
// never true for a thread that already has history — i.e. it fixed nothing for any EXISTING
// thread, and it never runs at all for any caller other than that one component (the drawer, a
// future API client, an agent-created thread). This module is what `assistant.controller.ts`'s
// `sendMessage` calls, in the SAME transaction as the first user message's INSERT, so every
// caller gets a real title — not just the one UI path that happened to call `handleRename`.
//
// The FE's `deriveThreadTitle` (platform-ui/src/lib/assistant.ts) is KEPT as a belt-and-braces
// optimistic update (see that file's own header note added alongside this change) rather than
// removed, so the sidebar shows a title the instant the message is sent rather than waiting for
// the POST /messages round trip. That is only safe because the two derivations are BYTE-FOR-BYTE
// IDENTICAL — same whitespace-collapse, same 60-char cap, same "only break on a word boundary if
// it leaves more than 20 chars" rule, same null-for-empty-input return — so whichever of the two
// writes (the FE's fire-and-forget PATCH, or this module's same-transaction UPDATE) lands last,
// it writes the SAME string the other one already wrote or would have written. If you change the
// algorithm here, change platform-ui/src/lib/assistant.ts's `deriveThreadTitle` in the same
// change, and vice versa — a drift between the two would make the title visibly flicker between
// two different strings depending on which request happened to commit first.
const THREAD_TITLE_MAX = 60;

// ASST-22's page-context preamble (`pageContextPrefix()`, platform-ui/src/lib/assistantContext.ts):
// `"[Context: <label> (<ref>)]\n\n"`, prepended onto the FIRST outgoing message of a thread opened
// with a page pinned, and persisted as-is (sent AND displayed, never a hidden addition — see that
// function's own header). Titling must run on the RAW user text, never this prefix, or every
// pinned-page thread would get the same "[Context: ..." boilerplate title. Non-greedy up to the
// first `]` so a label/ref containing no `]` is matched exactly once, anchored to the start of the
// string (the prefix is only ever prepended, never appears mid-message).
const PAGE_CONTEXT_PREFIX_RE = /^\[Context: .*?\]\n\n/;

function stripPageContextPrefix(raw: string): string {
  return raw.replace(PAGE_CONTEXT_PREFIX_RE, "");
}

/** Mirrors platform-ui's `deriveThreadTitle` (lib/assistant.ts) exactly — see this file's header
 *  for why that must stay true — but additionally strips the ASST-22 page-context preamble first,
 *  since (unlike the FE, which derives from the pre-prefix `text` variable it already has in
 *  hand) this runs against the PERSISTED `assistant_messages.content`, which carries the prefix
 *  baked in whenever the first message was sent with a page pinned. Returns `null` for
 *  empty/whitespace-only input, OR input that was only ever a page-context preamble with no real
 *  text after it — the caller must leave the thread untitled in both cases (rendered as
 *  "New chat" by `threadTitle()`), never a title that is empty or is itself the boilerplate. */
export function deriveServerThreadTitle(rawContent: string): string | null {
  const collapsed = stripPageContextPrefix(rawContent).replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= THREAD_TITLE_MAX) return collapsed;
  const cut = collapsed.slice(0, THREAD_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a word boundary if that leaves a reasonable amount of text — a single very long
  // first "word" (a pasted URL/token) is truncated at the character limit rather than left uncut
  // or chopped down to almost nothing. Byte-for-byte the same rule as the FE's own comment.
  const boundary = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${boundary.trimEnd()}…`;
}
