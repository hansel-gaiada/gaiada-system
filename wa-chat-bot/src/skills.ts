// Gaiada Assistant skill framework (Task 3.1). Commands plug in as skills; the router
// enforces the assurance ceiling (Task 3.2): a skill can demand `verified`, which a
// low-assurance chat principal can never satisfy — it gets a step-up prompt, not data.
import { config } from "./config";
import { complete } from "./llm";
import { callHubTool, HubDeniedError } from "./hub";
import { getMessages, saveMessage } from "./store";
import { summarizeChat } from "./summarize";
import { scrub } from "./scrub";
import { saveCaptureToDrive, driveEnabled } from "./drive";
import type { Principal } from "./principal";
import type { InboundMessage } from "./waha";

export interface SkillCtx {
  msg: InboundMessage;
  args: string;
  principal: Principal;
}

export interface Skill {
  name: string;
  description: string;
  /** Undefined = any caller. "verified" can never be met from chat (low assurance). */
  minAssurance?: "verified";
  handler: (ctx: SkillCtx) => Promise<string>;
}

const skills = new Map<string, Skill>();

export function registerSkill(s: Skill): void {
  skills.set(s.name, s);
}

export function listSkills(): Skill[] {
  return [...skills.values()];
}

export function resetSkills(): void {
  skills.clear();
}

function helpText(): string {
  const cmds = listSkills()
    .map((s) => `${config.commandPrefix}${s.name} — ${s.description}`)
    .join("\n");
  return `Commands:\n${cmds}\nOr mention ${config.botMention} / DM me a work question.`;
}

export async function routeCommand(name: string, ctx: SkillCtx): Promise<string> {
  const skill = skills.get(name.toLowerCase());
  if (!skill) return `Unknown command. Try ${config.commandPrefix}help.`;
  if (skill.minAssurance === "verified" && ctx.principal.assurance !== skill.minAssurance) {
    return `That needs a verified login — WhatsApp/Telegram chat can't grant it. I can help with general questions, this chat's history, ${config.commandPrefix}capture and ${config.commandPrefix}actions.`;
  }
  return skill.handler(ctx);
}

/** Quick captures live under a synthetic per-owner chat id — owner-only by construction. */
const captureChatId = (ownerId: string) => `capture:${ownerId}`;

export function registerBuiltins(): void {
  registerSkill({ name: "ping", description: "liveness check", handler: async () => "pong" });
  registerSkill({ name: "help", description: "this list", handler: async () => helpText() });
  registerSkill({
    name: "summarize",
    description: "project-status digest of this chat",
    handler: async ({ msg }) => summarizeChat(await getMessages(msg.chatId)),
  });
  registerSkill({
    name: "capture",
    description: "save a quick note (only you can list it)",
    handler: async ({ msg, args }) => {
      const note = args.trim();
      if (!note) return `Usage: ${config.commandPrefix}capture <note>`;
      const { clean } = scrub(note);
      await saveMessage({
        chatId: captureChatId(msg.senderId),
        senderId: msg.senderId,
        senderName: msg.senderName,
        waMessageId: msg.waMessageId,
        ts: msg.ts,
        text: clean,
        fromBot: false,
      });
      // Best-effort mirror to Drive through the governed connector (scrubbed text only).
      if (driveEnabled()) {
        const r = await saveCaptureToDrive(clean, msg.waMessageId);
        return r.saved ? "Captured (also saved to Drive)." : `Captured. (Drive save failed: ${r.reason})`;
      }
      return "Captured.";
    },
  });
  registerSkill({
    name: "captures",
    description: "list your saved notes",
    handler: async ({ msg }) => {
      const rows = await getMessages(captureChatId(msg.senderId));
      if (rows.length === 0) return "No captures yet.";
      return rows
        .slice(-20)
        .map((r) => `• ${new Date(r.ts).toISOString().slice(0, 10)} ${r.text}`)
        .join("\n");
    },
  });
  registerSkill({
    name: "know",
    description: "search company knowledge/docs (needs a linked, verified identity)",
    handler: async ({ msg, args }) => {
      const question = args.trim();
      if (!question) return `Usage: ${config.commandPrefix}know <question>`;
      if (!config.hubServiceToken) return "Knowledge search isn't connected on this bot (HUB_SERVICE_TOKEN unset).";
      const envelope = {
        provider: (msg.chatId.startsWith("tg:") ? "telegram" : "whatsapp") as "telegram" | "whatsapp",
        externalId: msg.senderId,
      };
      try {
        // WS8 knowledge service (D9) via the hub: authorization is the platform's job;
        // results are already tenant/ACL pre-filtered to what this identity may see.
        const raw = await callHubTool("knowledge.search", { query: question, scope: msg.chatId }, envelope);
        const hits = JSON.parse(raw) as Array<{ text: string; sourceRef: string }>;
        if (hits.length === 0) return "No matching company knowledge — nothing indexed for you yet, or nothing relevant.";
        const context = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n");
        return complete(
          `Answer the question using ONLY these company-knowledge snippets. Cite the [n] you used. If they don't answer it, say so.\n\n${context}\n\nQuestion: ${question}`,
        );
      } catch (err) {
        if (err instanceof HubDeniedError) {
          return "I can't search company knowledge for this chat identity. Ask an admin to link and verify your account.";
        }
        return `[knowledge search unavailable: ${(err as Error).message}]`;
      }
    },
  });

  registerSkill({
    name: "projects",
    description: "your company's projects (platform data — needs a linked, verified identity)",
    handler: async ({ msg }) => {
      if (!config.hubServiceToken) return "Company data isn't connected on this bot (HUB_SERVICE_TOKEN unset).";
      if (!config.defaultTenantId) return "No company is configured for this bot (DEFAULT_TENANT_ID unset).";
      const envelope = {
        provider: (msg.chatId.startsWith("tg:") ? "telegram" : "whatsapp") as "telegram" | "whatsapp",
        externalId: msg.senderId,
      };
      try {
        const raw = await callHubTool("projects.list", { tenantId: config.defaultTenantId }, envelope);
        const projects = JSON.parse(raw) as Array<{ name: string; status: string }>;
        if (projects.length === 0) return "No projects found.";
        return projects.map((p) => `• ${p.name} — ${p.status}`).join("\n");
      } catch (err) {
        if (err instanceof HubDeniedError) {
          // D4 in practice: unlinked/unverified senders get a step-up, never data.
          return "I can't show company data for this chat identity. Ask an admin to link and verify your account, then try again.";
        }
        return `[projects unavailable: ${(err as Error).message}]`;
      }
    },
  });

  registerSkill({
    name: "actions",
    description: "action items from this chat (incl. transcribed media)",
    handler: async ({ msg }) => {
      const rows = await getMessages(msg.chatId);
      if (rows.length === 0) return "No messages to extract action items from.";
      const lines = rows
        .slice(-200)
        .map((r) => `${r.senderName || r.senderId}: ${r.text}${r.mediaText ? ` [media: ${r.mediaText}]` : ""}`)
        .join("\n");
      return complete(
        `From this work-group chat, extract the concrete action items as a short bullet list — owner (if stated), task, deadline (if stated). Only items actually mentioned.\n\n--- CHAT ---\n${lines}\n--- END ---`,
      );
    },
  });
}
