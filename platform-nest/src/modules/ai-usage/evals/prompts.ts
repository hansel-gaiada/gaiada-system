// AIP-09 — the prompt of every eval case, built by the PRODUCTION builders (never a re-typed copy), except the one that lives in another package.
import { buildCompactionPrompt } from "../../assistant/context";
import { buildTriagePrompt as buildSocialTriagePrompt } from "../../social/ai-drafts";
import { buildTriagePrompt as buildAuditTriagePrompt } from "../../search/ai-drafts";
import type { CompactionCase } from "./cases";
import type { EvalCase } from "./score";

/** mcp-hub/src/tools.ts `llm.summarize`: `Summarize the following concisely for a work context:\n\n${text}`. mcp-hub is a separate package, so
 *  platform-nest cannot import it: this is a COPY, and prompts.test.ts reads tools.ts as text and fails when the two drift. */
export const HUB_SUMMARIZE_PREFIX = "Summarize the following concisely for a work context:\n\n";

export function buildHubSummarizePrompt(text: string): string {
  return `${HUB_SUMMARIZE_PREFIX}${text}`;
}

export function promptFor(c: EvalCase): string {
  if (c.task === "summarise") {
    return c.kind === "compaction"
      ? buildCompactionPrompt(c.source, (c as CompactionCase).existingSummary ?? null)
      : buildHubSummarizePrompt(c.source);
  }
  if (c.kind === "social") return buildSocialTriagePrompt({ network: c.network, engagementName: c.engagementName, messages: c.messages });
  return buildAuditTriagePrompt(c.findings);
}
