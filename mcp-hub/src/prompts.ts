// MCP Prompts (WS2 §6): reusable task templates AI clients can instantiate. Pure text — no
// data access, no secrets, no side effects. Templates only; the client fills the arguments.
// Available to identified callers (same floor as tools/resources).
import type { Principal } from "./principal";

export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}
export interface HubPrompt {
  name: string;
  description: string;
  arguments: PromptArg[];
  /** Build the user-message text from the supplied arguments. */
  render: (args: Record<string, string>) => string;
}

export const PROMPTS: HubPrompt[] = [
  {
    name: "summarize-project-status",
    description: "Summarize a project's status for a management update.",
    arguments: [
      { name: "projectName", description: "The project name", required: true },
      { name: "details", description: "Recent tasks / notes / blockers to summarize", required: true },
    ],
    render: (a) =>
      `Summarize the current status of the project "${a.projectName ?? ""}" for a concise management update. ` +
      `Cover progress, risks, and next steps in 3-5 bullet points.\n\nDetails:\n${a.details ?? ""}`,
  },
  {
    name: "draft-standup-digest",
    description: "Turn raw standup notes into a categorized team digest.",
    arguments: [{ name: "notes", description: "Raw standup notes", required: true }],
    render: (a) =>
      `Turn the following standup notes into a short team digest grouped by Done / In progress / Blocked. ` +
      `Keep it factual and skip filler.\n\nNotes:\n${a.notes ?? ""}`,
  },
  {
    name: "draft-client-update",
    description: "Draft a client-facing progress update.",
    arguments: [
      { name: "clientName", description: "The client name", required: true },
      { name: "highlights", description: "What to communicate", required: true },
    ],
    render: (a) =>
      `Draft a warm, professional progress update to the client "${a.clientName ?? ""}". ` +
      `Lead with outcomes, keep it under 150 words.\n\nHighlights:\n${a.highlights ?? ""}`,
  },
];

export function canUsePrompts(principal: Principal): boolean {
  return principal.assurance !== "anonymous";
}

export function getPrompt(name: string): HubPrompt | undefined {
  return PROMPTS.find((p) => p.name === name);
}
