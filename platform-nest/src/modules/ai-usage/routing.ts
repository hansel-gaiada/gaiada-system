// AIP-07 — the ONE place a call-site label becomes a gateway routing class (plan phase 2, "route by task").
//
// TWO VOCABULARIES, ON PURPOSE
//   * the call-site LABEL (`AiCallAttribution.task`, e.g. `social.draft_caption`): fine-grained, free text, written to `ai_usage_events.task`;
//   * the gateway TASK CLASS (`chat | summarise | classify | agent_step | draft`): what ai-gateway-go's `/complete` and `/complete/stream` route on.
// `ai_usage_events.task` KEEPS the call-site label (it is finer than the class); the class is always derivable from it with `gatewayTaskFor`.
// The gateway answers with the `tier` it applied (`fast | standard | strong`); that lands in `ai_usage_events.tier`.
//
// `/embed` and `/media` are NOT routed: never send `task` to them. An unknown label is `undefined` (the gateway's default), never a guess.
export const GATEWAY_TASKS = ["chat", "summarise", "classify", "agent_step", "draft"] as const;
export type GatewayTask = (typeof GATEWAY_TASKS)[number];

export const GATEWAY_TIERS = ["fast", "standard", "strong"] as const;
export type GatewayTier = (typeof GATEWAY_TIERS)[number];

/** The tier the gateway reported, or null for anything that is not exactly one of the three values. */
export function readGatewayTier(raw: unknown): GatewayTier | null {
  return typeof raw === "string" && (GATEWAY_TIERS as readonly string[]).includes(raw) ? (raw as GatewayTier) : null;
}

/** Every call-site label in use that is routed, and its class. A new `task: "<label>"` caller must be added here or to UNROUTED_TASKS (routing.test.ts enforces it). */
export const TASK_CLASS_BY_LABEL: Readonly<Record<string, GatewayTask>> = {
  "assistant.reply": "chat",
  "assistant.compaction": "summarise",
  "search.cluster_label": "summarise",
  "social.inbox_triage": "classify",
  "search.audit_triage": "classify",
  "search.brief_draft": "draft",
  "search.brief_polish": "draft",
  "search.rsa_draft": "draft",
  "search.negatives_proposal": "draft",
  "search.report_narrative": "draft",
  "social.content_brief_ideas": "draft",
  "social.content_brief_caption": "draft",
  "social.draft_caption": "draft",
  "social.draft_ideas": "draft",
  "social.report_narrative": "draft",
  "social.report_generate": "draft",
  "social.audit_summary": "draft",
  "reports.narrative": "draft",
  "clients.account_summary": "draft",
  "webdev.assist": "draft",
};

/** Labels deliberately NOT routed (embed / media calls go to `/embed` or `/media`, which take no `task`). */
export const UNROUTED_TASKS: readonly string[] = ["search.embed_keyword"];

/** The gateway task class for a call-site label; undefined when unmapped (the caller then omits the `task` key entirely). */
export function gatewayTaskFor(callSiteTask: string | null | undefined): GatewayTask | undefined {
  if (typeof callSiteTask !== "string") return undefined;
  return Object.prototype.hasOwnProperty.call(TASK_CLASS_BY_LABEL, callSiteTask) ? TASK_CLASS_BY_LABEL[callSiteTask] : undefined;
}

/** `{ task }` when the label maps, else `{}`: spread into a request body so an unmapped label leaves the body byte-identical to before. */
export function gatewayTaskField(callSiteTask: string | null | undefined): { task?: GatewayTask } {
  const task = gatewayTaskFor(callSiteTask);
  return task ? { task } : {};
}
