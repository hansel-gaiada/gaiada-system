// Group-administration actions (Phase F) — the highest-risk category. execute() calls the
// ChatGateway verbs (Phase B) directly; authorization still runs through the executor
// gauntlet against the `chat_group` Cerbos resource (verified-only, confirmed). Each action
// checks the surface capability and reports honestly when a verb isn't supported there.
import { registerAction } from "./registry";
import { supports } from "../gateway/capabilities";
import type { ActionResult, ActionContext } from "./types";
import type { GatewayVerb } from "../gateway/contract";

async function runVerb(
  ctx: ActionContext,
  verb: GatewayVerb,
  call: () => Promise<{ ok: boolean; unsupported?: boolean; error?: string; ref?: string }>,
  okMessage: string,
): Promise<ActionResult> {
  if (!supports(ctx.surface, verb)) return { ok: false, message: `${ctx.surface} can't ${verb} in this chat.` };
  const r = await call();
  if (r.unsupported) return { ok: false, message: `Not supported on ${ctx.surface}.` };
  if (!r.ok) return { ok: false, message: `Failed: ${r.error ?? "unknown error"}` };
  return { ok: true, message: okMessage, ref: r.ref };
}

export function registerGroupAdminActions(): void {
  registerAction<{ userId: string }>({
    name: "group.remove",
    description: "remove a member from this group",
    category: "group-admin",
    riskTier: "high",
    cerbos: { resource: "chat_group", action: "remove_member" },
    validate: (raw) => {
      const userId = (typeof raw === "string" ? raw : String((raw as any).userId ?? "")).trim().split(/\s+/)[0] ?? "";
      return userId ? { ok: true, args: { userId } } : { ok: false, error: "Usage: /group remove <userId>" };
    },
    preview: (a) => `Remove ${a.userId} from this group.`,
    execute: (a, ctx) => runVerb(ctx, "removeMember", () => ctx.gateway.removeMember(ctx.chatId, a.userId), `✅ Removed ${a.userId}.`),
  });

  registerAction<{ userId: string }>({
    name: "group.promote",
    description: "make a member an admin of this group",
    category: "group-admin",
    riskTier: "high",
    cerbos: { resource: "chat_group", action: "promote_member" },
    validate: (raw) => {
      const userId = (typeof raw === "string" ? raw : String((raw as any).userId ?? "")).trim().split(/\s+/)[0] ?? "";
      return userId ? { ok: true, args: { userId } } : { ok: false, error: "Usage: /group promote <userId>" };
    },
    preview: (a) => `Promote ${a.userId} to group admin.`,
    execute: (a, ctx) => runVerb(ctx, "promote", () => ctx.gateway.promote(ctx.chatId, a.userId), `✅ Promoted ${a.userId}.`),
  });

  registerAction<{ subject: string }>({
    name: "group.rename",
    description: "change this group's name/subject",
    category: "group-admin",
    riskTier: "high",
    cerbos: { resource: "chat_group", action: "set_subject" },
    validate: (raw) => {
      const subject = (typeof raw === "string" ? raw : String((raw as any).subject ?? "")).trim();
      return subject ? { ok: true, args: { subject } } : { ok: false, error: "Usage: /group rename <new name>" };
    },
    preview: (a) => `Rename this group to "${a.subject}".`,
    execute: (a, ctx) => runVerb(ctx, "setSubject", () => ctx.gateway.setSubject(ctx.chatId, a.subject), `✅ Renamed to "${a.subject}".`),
  });

  registerAction<{ messageId: string }>({
    name: "group.pin",
    description: "pin a message in this group",
    category: "group-admin",
    riskTier: "high",
    cerbos: { resource: "chat_group", action: "pin" },
    validate: (raw) => {
      const messageId = (typeof raw === "string" ? raw : String((raw as any).messageId ?? "")).trim().split(/\s+/)[0] ?? "";
      return messageId ? { ok: true, args: { messageId } } : { ok: false, error: "Usage: /group pin <messageId>" };
    },
    preview: (a) => `Pin message ${a.messageId}.`,
    execute: (a, ctx) => runVerb(ctx, "pin", () => ctx.gateway.pin(ctx.chatId, a.messageId), `✅ Pinned message ${a.messageId}.`),
  });
}
