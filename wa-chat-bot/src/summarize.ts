import { complete } from "./llm";
import { config } from "./config";
import { persona, dataNote, fence } from "./persona";
import type { StoredMessage } from "./store";

function mediaLine(m: StoredMessage): string {
  if (m.mediaStatus === "done" && m.mediaText) return ` [media: ${m.mediaText}]`;
  if (m.mediaStatus === "pending") return " [media attached — still processing]";
  if (m.mediaStatus === "failed") return ` ${m.mediaText ?? "[media unavailable]"}`;
  return "";
}

function transcript(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      const who = m.fromBot ? "Bot" : m.senderName || m.senderId || "Unknown";
      const when = new Date(m.ts).toISOString().slice(0, 16).replace("T", " ");
      return `[${when}] ${who}: ${m.text}${mediaLine(m)}`;
    })
    .join("\n");
}

// Digests are an internal, silent report (they go to the management channel, not chatty replies),
// so they get the injection guard but NOT the conversational persona — the output must stay a
// neutral, factual status digest.
const DIGEST_INSTRUCTIONS = `You are a work-group assistant producing an internal status report. From the chat transcript below, write a concise project-status digest with these sections (omit a section only if truly empty):

• Discussion summary — a brief recap of what was discussed.
• Projects — ongoing & new — each project mentioned and its current status/progress.
• Needs help / not finished — open items, blockers, or explicit help requests.
• Behind schedule — anything described as delayed or at risk.
• Open questions — questions raised that were not answered.
• Answered questions — questions that were resolved, with the resolution.

Only use what is in the transcript. Be factual and brief (about 150-250 words). Do not invent details.

${dataNote()}`;

const REDUCE_INSTRUCTIONS = `You are a work-group assistant producing an internal status report. Below are several partial digests, each covering a slice of the same day's chat, in order. Merge them into ONE project-status digest with the same sections (Discussion summary · Projects — ongoing & new · Needs help / not finished · Behind schedule · Open questions · Answered questions). Deduplicate, and let later slices resolve/close items raised in earlier ones. Be factual and brief (about 150-250 words).

${dataNote()}`;

/** Split messages into windows whose rendered transcript stays under the char budget.
 *  Deterministic (no overlap, preserves order) so map-reduce is reproducible. */
function chunkByTranscriptSize(messages: StoredMessage[], maxChars: number): StoredMessage[][] {
  const chunks: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let size = 0;
  for (const m of messages) {
    const line = transcript([m]).length + 1;
    if (current.length > 0 && size + line > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(m);
    size += line;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function summarizeChat(messages: StoredMessage[]): Promise<string> {
  if (messages.length === 0) return "No messages in this window — the group was quiet.";
  const full = transcript(messages);
  // Fits in one pass → single call (unchanged behavior for normal windows).
  if (full.length <= config.summarizeMaxChars) {
    return complete(`${DIGEST_INSTRUCTIONS}\n\n${fence("TRANSCRIPT", full)}`);
  }
  // Oversized window → map-reduce: summarize each chunk, then merge the partials.
  const chunks = chunkByTranscriptSize(messages, config.summarizeMaxChars);
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = await complete(
      `${DIGEST_INSTRUCTIONS}\n\n(This is slice ${i + 1} of ${chunks.length} of the day's chat.)\n\n${fence("TRANSCRIPT", transcript(chunks[i]))}`,
    );
    partials.push(`### Slice ${i + 1}\n${part}`);
  }
  return complete(`${REDUCE_INSTRUCTIONS}\n\n${fence("PARTIAL DIGESTS", partials.join("\n\n"))}`);
}

// Conversational Q&A: persona + scope-limited + injection-fenced history and question. Scope is
// intentionally narrow — the agency's work — not open-ended general knowledge, so the bot declines
// off-topic asks instead of answering them.
export async function answerQuestion(question: string, history: StoredMessage[]): Promise<string> {
  const prompt = [
    persona(),
    "",
    "A team member asked you something in a work chat. Answer using the chat history below and what you know about the agency's work. If the answer isn't there and isn't something you genuinely know about the work, say you don't have it — don't guess. If the question is off-topic or out of scope, decline in one friendly line per your boundaries.",
    "",
    fence("RECENT CHAT HISTORY", transcript(history.slice(-100))),
    "",
    fence("QUESTION FROM THE USER", question),
  ].join("\n");
  return complete(prompt);
}
