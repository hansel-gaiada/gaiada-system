// Surface router: one send interface over both chat surfaces. Chat ids carry their
// surface (`tg:` prefix = Telegram, else WhatsApp), so digests and replies always leave
// through the surface the chat lives on — Telegram keeps working when WAHA is down.
//
// This is also the single universal choke point for outbound abuse/ban protection (2026-07-29
// hardening): it is the gateway instance used for the WA webhook, the digest scheduler AND
// every admin digest route (server.ts defaults `gateway` to `new SurfaceRouter()` in all of
// those), so gating here covers all of them with no changes to those files. The manual
// outbound halt and the global rate ceiling are checked on every CONTENT-bearing verb
// (sendText/sendButtons/sendMedia/reply) before it reaches WAHA/Telegram; group-admin verbs
// (addMember/promote/etc.) are left to the action executor's own kill-switch + per-action rate
// limit (executor.ts), which already gate them — double-gating would only add noise.
//
// Fixes a pre-existing functional bug as a side effect: this class previously implemented only
// `sendText` (WhatsAppGateway), not the full ChatGateway. In production the WA webhook path
// passes exactly this instance as `ctx.gateway` (actions/dispatch.ts buildCtx), so any
// group-admin action (`/group remove|promote|rename|pin`) calling `ctx.gateway.removeMember`
// etc. would throw "not a function" — and `actions/dispatch.ts`'s
// `typeof full.sendButtons === "function"` check silently failed too, so action-confirmation
// prompts sent no button/numbered-option text at all (just the preview + "Confirm?", with no
// visible way to confirm). Implementing the full interface here fixes both.
import { WahaGateway } from "./waha";
import { TelegramGateway } from "./telegram";
import type { WhatsAppGateway } from "./waha";
import type { ChatGateway, GatewayResult, MediaPayload, ActionButton } from "./gateway/contract";
import { checkOutboundCeiling, OUTBOUND_CEILING_ERROR } from "./safety/outbound-ceiling";
import { outboundHaltEnabled } from "./safety/outbound-halt";
import { recordOutboundText } from "./safety/loop-guard";

/** Thrown for any content-bearing send blocked by the halt switch or the global ceiling.
 *  Callers (sendWithRetry, schedule.ts's own try/catch, admin routes) already treat a thrown
 *  send as a failure and log/record it — this reuses that path rather than adding a new one. */
class OutboundBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundBlockedError";
  }
}

export class SurfaceRouter implements ChatGateway {
  constructor(
    private wa: ChatGateway = new WahaGateway(),
    private tg: ChatGateway = new TelegramGateway(),
  ) {}

  private target(chatId: string): ChatGateway {
    return chatId.startsWith("tg:") ? this.tg : this.wa;
  }

  /** Gate every content-bearing send: manual halt first (cheap, operator-controlled), then the
   *  automatic global ceiling. Records the text for echo-loop detection on the way out (best
   *  effort — recording is advisory, never blocks or fails the send). */
  private guard(text: string): void {
    if (outboundHaltEnabled()) {
      throw new OutboundBlockedError("outbound halt is enabled — all sends are stopped");
    }
    const ceiling = checkOutboundCeiling();
    if (!ceiling.allowed) {
      throw new OutboundBlockedError(OUTBOUND_CEILING_ERROR);
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    this.guard(text);
    recordOutboundText(chatId, text);
    return this.target(chatId).sendText(chatId, text);
  }

  async reply(chatId: string, replyToId: string, text: string): Promise<GatewayResult> {
    try {
      this.guard(text);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    recordOutboundText(chatId, text);
    return this.target(chatId).reply(chatId, replyToId, text);
  }

  async sendMedia(chatId: string, media: MediaPayload): Promise<GatewayResult> {
    try {
      this.guard(media.caption ?? "");
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    return this.target(chatId).sendMedia(chatId, media);
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<GatewayResult> {
    try {
      this.guard("");
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    return this.target(chatId).react(chatId, messageId, emoji);
  }

  async sendButtons(chatId: string, text: string, buttons: ActionButton[]): Promise<GatewayResult> {
    try {
      this.guard(text);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    recordOutboundText(chatId, text);
    return this.target(chatId).sendButtons(chatId, text, buttons);
  }

  // Non-content-bearing / group-admin verbs: pass straight through. Already individually
  // gated by the action executor's kill-switch + high-risk-tier rate limit before execute()
  // is ever reached (see actions/executor.ts, actions/group-admin.ts).
  typing(chatId: string, on: boolean): Promise<GatewayResult> {
    return this.target(chatId).typing(chatId, on);
  }
  addMember(chatId: string, userId: string): Promise<GatewayResult> {
    return this.target(chatId).addMember(chatId, userId);
  }
  removeMember(chatId: string, userId: string): Promise<GatewayResult> {
    return this.target(chatId).removeMember(chatId, userId);
  }
  promote(chatId: string, userId: string): Promise<GatewayResult> {
    return this.target(chatId).promote(chatId, userId);
  }
  demote(chatId: string, userId: string): Promise<GatewayResult> {
    return this.target(chatId).demote(chatId, userId);
  }
  setSubject(chatId: string, subject: string): Promise<GatewayResult> {
    return this.target(chatId).setSubject(chatId, subject);
  }
  pin(chatId: string, messageId: string): Promise<GatewayResult> {
    return this.target(chatId).pin(chatId, messageId);
  }
  inviteLink(chatId: string): Promise<GatewayResult> {
    return this.target(chatId).inviteLink(chatId);
  }
}

// Re-exported for callers that only need the narrow send-only shape (unchanged import surface).
export type { WhatsAppGateway };
