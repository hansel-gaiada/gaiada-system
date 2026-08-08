// P4-J4 — WhatsApp PM skill (2026-08-04 Phase-4 plan, workstream J):
// "Integrate WA bot to read, modify and write if the requesting user has the RBAC to do that,
// otherwise read only." Same shape as skills.ts's existing `/projects` and `/know`: forward the
// sender's (provider, externalId) OBO envelope to the hub's pm.* tools (mcp-hub/src/pm-tools.ts)
// and render whatever the platform answers. Nothing here is new authority — it's a thinner front
// than /projects, because these tools already do their own facet-building.
//
// NON-NEGOTIABLE #1 (own the rule, don't just cite it): there is no role/tenant/client-vs-staff
// branch anywhere in this file. Every handler forwards args + the caller's envelope and prints
// the result. "Otherwise read-only" is produced by the platform's Cerbos/RLS 403 — never by an
// `if` here. If you're tempted to add one, that's the bug the plan warns about.
//
// NON-NEGOTIABLE #2: denial text is rendered, not swallowed. /know and /projects collapse every
// HubDeniedError to one "link and verify" message, which is correct THERE because their only
// failure mode is "you're not a linked/verified identity" (D4) — one message covers every case.
// PM tools have a richer failure surface: a Cerbos role denial ("you don't have pm.write") and a
// P4-I1 chain-enforcement 409 (the platform's `{error}` body naming the exact blocking task) both
// carry information the D4 message would destroy. `renderDenial` below prints `err.message`
// (stripping the hub's generic "tool failed: " wrapper — see hub.ts's CallToolRequestSchema
// handler, which is where that prefix comes from) verbatim. An agent/human that sees "you're
// blocked by Design mockup" can act on it; one that sees "something went wrong" cannot, and stops
// trusting the bot.
import { config } from "./config";
import { callHubTool, HubDeniedError, type HubEnvelope } from "./hub";
import type { Skill, SkillCtx } from "./skills";
import type { InboundMessage } from "./waha";

// ---------------------------------------------------------------------------------------------
// Natural-language-ish parsing. Deliberately keyword/token based (no LLM call, no network round
// trip before we even know if the caller may act) — mirrors how /know and /projects are plain
// command handlers today. This is presentation glue only: it decides which pm.* tool to call and
// how to shape its args, never whether the call is allowed.
// ---------------------------------------------------------------------------------------------

export type PmIntent =
  | { kind: "mine" }
  | { kind: "show"; taskId: string }
  | { kind: "history"; taskId: string }
  | { kind: "status"; taskId: string; status: string; blockReason?: string }
  | { kind: "due"; taskId: string; dueDate: string | null }
  | { kind: "pass"; taskId: string; refId: string; note?: string }
  | { kind: "comment"; taskId: string; body: string }
  | { kind: "help" };

// Cosmetic aliasing ONLY, for the default status ladder (P4-B8: backlog/todo/doing/blocked/done).
// A project with its own custom registry (e.g. "ready_to_check") still works — an unrecognized
// word passes through lowercased/hyphenated, and the platform is the one that validates it against
// that project's ACTUAL registry (a bad id 400s there, not here).
const STATUS_ALIASES: Record<string, string> = {
  "to do": "todo",
  "to-do": "todo",
  todo: "todo",
  "in progress": "doing",
  "in-progress": "doing",
  inprogress: "doing",
  doing: "doing",
  backlog: "backlog",
  blocked: "blocked",
  done: "done",
  complete: "done",
  completed: "done",
  finished: "done",
};

function normalizeStatus(raw: string): string {
  const key = raw.trim().toLowerCase();
  return STATUS_ALIASES[key] ?? key.replace(/\s+/g, "-");
}

const FILLER = new Set(["to", "as", "status"]);

/** Parses the free text after `/pm`. Unrecognized shapes fall through to `{kind:"help"}` rather
 *  than guessing — a wrong guess that silently calls the wrong tool is worse than asking again. */
export function parsePmCommand(raw: string): PmIntent {
  const text = raw.trim();
  if (!text || /^(mine|my tasks|my task|list)$/i.test(text)) return { kind: "mine" };

  const tokens = text.split(/\s+/);
  const verb = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (["show", "task", "get", "view"].includes(verb) && rest[0]) {
    return { kind: "show", taskId: rest[0] };
  }
  if (["history", "log"].includes(verb) && rest[0]) {
    return { kind: "history", taskId: rest[0] };
  }
  if (["status", "move", "set"].includes(verb) && rest.length >= 2) {
    const taskId = rest[0];
    const words = rest.slice(1).filter((w) => !FILLER.has(w.toLowerCase()));
    if (words.length === 0) return { kind: "help" };
    // Try a 2-word alias first ("in progress", "to do") before falling back to one word, or the
    // second word gets misread as the start of blockReason instead of part of the status.
    const twoWord = words.length >= 2 ? words.slice(0, 2).join(" ").toLowerCase() : "";
    const status = twoWord && STATUS_ALIASES[twoWord] ? STATUS_ALIASES[twoWord] : normalizeStatus(words[0]);
    const consumed = twoWord && STATUS_ALIASES[twoWord] ? 2 : 1;
    return { kind: "status", taskId, status, blockReason: words.slice(consumed).join(" ") || undefined };
  }
  if (["due", "schedule", "deadline"].includes(verb) && rest.length >= 2) {
    const taskId = rest[0];
    const dateWord = rest[1];
    const dueDate = /^(clear|none|remove)$/i.test(dateWord) ? null : dateWord;
    return { kind: "due", taskId, dueDate };
  }
  if (["pass", "assign", "ball"].includes(verb) && rest.length >= 2) {
    const taskId = rest[0];
    const words = rest.slice(1).filter((w) => w.toLowerCase() !== "to");
    if (!words[0]) return { kind: "help" };
    return { kind: "pass", taskId, refId: words[0], note: words.slice(1).join(" ") || undefined };
  }
  if (["comment", "note", "say"].includes(verb) && rest.length >= 2) {
    return { kind: "comment", taskId: rest[0], body: rest.slice(1).join(" ") };
  }
  // A bare id ("/pm 3f9c2a11-..." or "/pm t1") is the common case once someone has an id from
  // /pm mine — but a single ENGLISH WORD ("/pm frobnicate") must not be guessed as an id just
  // because it's alphanumeric. Require a digit or a hyphen (every real id — UUID or "TASK-1"
  // style — has one; ordinary words essentially never do), or fall through to help.
  if (tokens.length === 1 && /^[A-Za-z0-9-]{4,}$/.test(tokens[0]) && /[0-9-]/.test(tokens[0])) {
    return { kind: "show", taskId: tokens[0] };
  }
  return { kind: "help" };
}

const PM_HELP = [
  "Usage:",
  "  /pm [mine] — your open tasks (Ball or Responsible)",
  "  /pm show <taskId> — task detail",
  "  /pm history <taskId> — ball/assignment history",
  "  /pm status <taskId> <status> [reason] — move status (e.g. doing, done)",
  "  /pm due <taskId> <YYYY-MM-DD|clear>",
  "  /pm pass <taskId> <userId> [note] — pass the ball",
  "  /pm comment <taskId> <text>",
].join("\n");

// ---------------------------------------------------------------------------------------------
// Hub plumbing + rendering
// ---------------------------------------------------------------------------------------------

function envelopeFor(msg: InboundMessage): HubEnvelope {
  return {
    provider: (msg.chatId.startsWith("tg:") ? "telegram" : "whatsapp") as "telegram" | "whatsapp",
    externalId: msg.senderId,
  };
}

/** The other half of NON-NEGOTIABLE #2: strip the hub's generic wrapper, keep everything else
 *  verbatim. `tool failed: ` is added by mcp-hub/src/hub.ts's CallToolRequestSchema catch branch
 *  around whatever the tool handler threw (pm-tools.ts's platformSend forwards the platform's own
 *  `{error}` body there); a plain policy/Cerbos deny has no such prefix to begin with. Either way
 *  the substantive text — the Cerbos reason, or the P4-I1 409's named blocker — survives intact. */
function renderDenial(err: HubDeniedError): string {
  const reason = err.message.replace(/^tool failed: /, "").trim();
  return `Can't do that: ${reason || "denied"}`;
}

function unavailable(action: string, err: unknown): string {
  return `[pm ${action} unavailable: ${(err as Error).message}]`;
}

type Assignee = { kind: string; refId: string; refName: string; responsibleId: string; responsibleName: string } | null;

function ballLabel(assignee: Assignee): string {
  return assignee?.refName || assignee?.refId || "unassigned";
}

function responsibleLabel(assignee: Assignee): string {
  return assignee?.responsibleName || assignee?.responsibleId || "unassigned";
}

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  assignee: Assignee;
  projectName?: string;
}

function renderTaskLine(t: TaskSummary): string {
  const due = t.dueDate ? ` due ${t.dueDate}` : "";
  const proj = t.projectName ? ` (${t.projectName})` : "";
  return `• [${t.id}] ${t.title}${proj} — ${t.status}${due} — ball: ${ballLabel(t.assignee)}`;
}

interface TaskDetail extends TaskSummary {
  responsibleId?: string;
  description?: string;
  blockedBy: Array<{ id: string; title: string }>;
}

function renderTaskDetail(t: TaskDetail): string {
  const lines = [
    `${t.title} [${t.id}]`,
    t.projectName ? `Project: ${t.projectName}` : undefined,
    `Status: ${t.status}${t.blockedBy.length ? ` — blocked by ${t.blockedBy.map((b) => `"${b.title}"`).join(", ")}` : ""}`,
    `Ball: ${ballLabel(t.assignee)}  Responsible: ${responsibleLabel(t.assignee)}`,
    `Due: ${t.dueDate ?? "none"}`,
  ];
  return lines.filter((l): l is string => !!l).join("\n");
}

interface AssignmentEvent {
  refId: string | null;
  refName: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  statusId: string;
  note: string | null;
  changedByName: string | null;
  createdAt: string;
}

function renderHistory(events: AssignmentEvent[]): string {
  if (events.length === 0) return "No assignment history yet.";
  return events
    .map((e) => {
      const who = e.refName || e.refId || "unassigned";
      const by = e.changedByName ? ` (by ${e.changedByName})` : "";
      const note = e.note ? ` — ${e.note}` : "";
      return `• ${e.createdAt} → ${who} [${e.statusId}]${by}${note}`;
    })
    .join("\n");
}

async function handlePm({ msg, args }: SkillCtx): Promise<string> {
  if (!config.hubServiceToken) return "Company data isn't connected on this bot (HUB_SERVICE_TOKEN unset).";
  if (!config.defaultTenantId) return "No company is configured for this bot (DEFAULT_TENANT_ID unset).";

  const tenantId = config.defaultTenantId;
  const envelope = envelopeFor(msg);
  const intent = parsePmCommand(args);

  try {
    switch (intent.kind) {
      case "mine": {
        const raw = await callHubTool("pm.listTasks", { tenantId, mine: true, includeClosed: false, limit: 15 }, envelope);
        const { items } = JSON.parse(raw) as { items: TaskSummary[] };
        if (items.length === 0) return "You have no open tasks right now (checked Ball and Responsible).";
        return items.map(renderTaskLine).join("\n");
      }
      case "show": {
        const raw = await callHubTool("pm.getTask", { tenantId, taskId: intent.taskId }, envelope);
        return renderTaskDetail(JSON.parse(raw) as TaskDetail);
      }
      case "history": {
        const raw = await callHubTool("pm.taskAssignmentHistory", { tenantId, taskId: intent.taskId }, envelope);
        return renderHistory(JSON.parse(raw) as AssignmentEvent[]);
      }
      case "status": {
        const body: Record<string, unknown> = { tenantId, taskId: intent.taskId, status: intent.status };
        if (intent.blockReason) body.blockReason = intent.blockReason;
        await callHubTool("pm.setStatus", body, envelope);
        return `Status updated to "${intent.status}".`;
      }
      case "due": {
        await callHubTool("pm.setDueDate", { tenantId, taskId: intent.taskId, dueDate: intent.dueDate }, envelope);
        return intent.dueDate ? `Due date set to ${intent.dueDate}.` : "Due date cleared.";
      }
      case "pass": {
        await callHubTool("pm.passBall", { tenantId, taskId: intent.taskId, refId: intent.refId, assignmentNote: intent.note }, envelope);
        return `Ball passed to ${intent.refId}.`;
      }
      case "comment": {
        await callHubTool("pm.comment", { tenantId, taskId: intent.taskId, body: intent.body }, envelope);
        return "Comment posted.";
      }
      case "help":
      default:
        return PM_HELP;
    }
  } catch (err) {
    // This is the ONLY branch in this file that inspects the error, and it never inspects WHO the
    // caller is or WHAT they're allowed to do — only whether the platform/hub answered with a
    // denial (render its reason, NON-NEGOTIABLE #2) or the call itself failed transport-side
    // (render that it's unavailable, same fallback shape as /projects/`/know`).
    if (err instanceof HubDeniedError) return renderDenial(err);
    return unavailable(intent.kind, err);
  }
}

export function pmSkills(): Skill[] {
  return [
    {
      name: "pm",
      description: "your PM work — read/update tasks (needs a linked identity; write access follows your RBAC)",
      handler: handlePm,
    },
  ];
}
