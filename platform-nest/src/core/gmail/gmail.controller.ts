// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48, PERMISSION-CONTRACT §40) — email from the ERP through your OWN Gmail. Routes and authorisation only; the
// flow, the vault and Gmail are in service.ts and integrations/gmail/.
//
// ── THE GATE: THE NEW `personal_mailbox` KIND, ALWAYS WITH `ownerId` = THE CALLER ────────────────
// Every route authorises `personal_mailbox` with `ownerId: req.principal.userId`. The owner is NEVER a parameter, a header or a body field:
// the routes have no `:userId`, and the connection row is read by `owner_id = caller`. The policy then lets only the owner through, so a
// company_admin or a platform_admin reaches nobody else's mail (resource_personal_mailbox.yaml). `connect` gates the connection routes,
// `read` the two read routes, `send` the send route.
//
// ── ORDER OF THE SEND HANDLER (authorise first, then validate, as DW-6i's attach) ────────────────
//   (1) `personal_mailbox` · `send`; (2) with a `context`: `client` · `read`, the check `GET /clients/:clientId` makes (with the client's id
//   when it is shaped like one), so a caller who may not read the client learns nothing, not even whether it exists; (3) only now the body is
//   validated (400 `gmail_send_invalid` with `field`); (4) the client must exist in this tenant; (5) the connection (409), the limit (429), the send.
//
// ── NOTHING FROM THE MAILBOX IS STORED OR LOGGED ─────────────────────────────────────────────────
// The activity row of a send records who sent, when, how many recipients and the mode, never a subject, a body or an address.
//
// ── THE CALLBACK ─────────────────────────────────────────────────────────────────────────────────
// As DW-6i's: Google's redirect is a bare top-level navigation, so the registered `redirect_uri` is a page the front end owns, which calls THIS
// route as an ordinary authenticated BFF request. No `:tenantId`: the tenant and the person come only from the VERIFIED state, and the surface's
// own Cerbos check runs against that tenant BEFORE the state is spent. Live mode only.
//
// ── ERRORS ───────────────────────────────────────────────────────────────────────────────────────
// A refusal puts its token at the START of `message` and repeats it in `reason`: `gmail_not_configured`, `gmail_not_connected`,
// `gmail_needs_reconnect`, `gmail_unavailable`, `gmail_state_invalid`, `gmail_exchange_failed`, `gmail_send_invalid` (+ `field`),
// `gmail_send_rate_limited` (+ `retryAfterSeconds`), `gmail_rate_limited` (+ `retryAfterSeconds`), `gmail_not_found`,
// `gmail_request_invalid` (+ `field`). No error, log line or activity row ever carries a token or any of the mailbox.
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { withTenants } from "../../db";
import { authorize, writeActivity } from "../http";
import { isUuidShaped } from "../dept-resolution";
import { googleSurfaceFor } from "../google-oauth/registry";
import { GOOGLE_GMAIL_SURFACE } from "./surface";
import {
  completeConnect, disconnect, gmailError, isListLabel, isPageToken, isThreadId, listThreadsAnswer, notConfigured, parseSendRequest,
  requestInvalid, sendAnswer, sendInvalid, startConnect, statusAnswer, threadAnswer, verifiedStateTenant,
  type GmailStatusAnswer, type SendAnswer, type ThreadAnswer, type ThreadListAnswer,
} from "./service";
import { gmailMode } from "./mode";
import { gmailLiveConfigured } from "../../config";
import { recipientCount } from "../../integrations/gmail/send-validation";

/** What `start` answers: Google's consent URL (live) or the simulated link (never the connection id). */
type StartResponse = { mode: "live"; authUrl: string } | { mode: "simulated"; linked: true; accountEmail: string };

const objectOf = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

/** The caller's user id; a mailbox is a PERSON's, so a principal with none is refused (after the authz gate). */
function requireUser(req: FastifyRequest): string {
  const me = req.principal.userId;
  if (!me) throw gmailError(400, "user_required", "an authenticated user is required.");
  return me;
}

/** The mailbox as Cerbos sees it: the caller's own, always. */
const mailbox = (tenantId: string, me: string) => ({ kind: "personal_mailbox", tenantId, ownerId: me });

@Controller("api")
@UseGuards(AuthGuard)
export class GmailController {
  // ───────────────────────────── the connection (§48.2) ─────────────────────────────

  /** `{ configured, connected, needsReconnect, accountEmail, mode }` for the caller only. Never calls Google. */
  @Get(":tenantId/integrations/gmail")
  async status(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<GmailStatusAnswer> {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, mailbox(tenantId, me), "connect");
    return statusAnswer(tenantId, requireUser(req));
  }

  /** Live: `{ mode, authUrl }`, where to send the browser. Simulated: `{ mode, linked: true, ... }`, the simulated mailbox is linked at once. */
  @Get(":tenantId/integrations/gmail/oauth/start")
  async start(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<StartResponse> {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, mailbox(tenantId, me), "connect");
    const out = await startConnect(tenantId, requireUser(req));
    if (out.mode === "simulated") {
      // The audit row: that it was linked and in which mode. Never the address.
      await writeActivity(tenantId, me, "connected", "integration_connection", out.connectionId, { provider: "google_gmail", mode: "simulated" });
      return { mode: out.mode, linked: true, accountEmail: out.accountEmail };
    }
    return out;
  }

  /** Revokes at Google (live, best effort, reported) and clears the sealed tokens; simulated: clears the link and the simulated Sent. */
  @Delete(":tenantId/integrations/gmail")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, mailbox(tenantId, me), "connect");
    const out = await disconnect(tenantId, requireUser(req));
    if (out.disconnected) {
      await writeActivity(tenantId, me, "disconnected", "integration_connection", out.connectionId, {
        provider: "google_gmail", mode: out.mode, revokedAtGoogle: out.revokedAtGoogle,
      });
    }
    return { disconnected: out.disconnected, revokedAtGoogle: out.revokedAtGoogle, mode: out.mode };
  }

  // ───────────────────────────── reading your own mail (§48.3) ─────────────────────────────

  /** `?label=INBOX|SENT&pageToken=` → `{ mode, threads: [{ id, snippet, subject, from, lastMessageDate, unread }], nextPageToken }`. */
  @Get(":tenantId/mail/me/threads")
  async threads(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("label") label?: unknown,
    @Query("pageToken") pageToken?: unknown,
  ): Promise<ThreadListAnswer> {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, mailbox(tenantId, me), "read");
    const lab = label === undefined || label === "" ? "INBOX" : label;
    if (!isListLabel(lab)) throw requestInvalid("label", "label must be INBOX or SENT.");
    if (pageToken !== undefined && pageToken !== "" && !isPageToken(pageToken)) throw requestInvalid("pageToken", "pageToken is not one this API issued.");
    return listThreadsAnswer(tenantId, requireUser(req), {
      label: lab,
      ...(typeof pageToken === "string" && pageToken ? { pageToken } : {}),
    });
  }

  /** One thread of your own mailbox, every message decoded: headers, the text part, the sanitized HTML part, attachment metadata only. */
  @Get(":tenantId/mail/me/threads/:threadId")
  async thread(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("threadId") threadId: string): Promise<ThreadAnswer> {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, mailbox(tenantId, me), "read");
    if (!isThreadId(threadId)) throw requestInvalid("threadId", "threadId is not a thread id.");
    return threadAnswer(tenantId, requireUser(req), threadId);
  }

  // ───────────────────────────── sending, replying and "Email this client" (§48.4) ─────────────────────────────

  /** `{ to, cc?, subject, body, inReplyTo?: { threadId, messageId }, context?: { kind: "client", id } }` → 202 `{ mode, messageId, threadId }`. */
  @Post(":tenantId/mail/me/send")
  @HttpCode(202)
  async send(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown): Promise<SendAnswer> {
    const b = objectOf(body);
    const me = req.principal.userId ?? "";

    // (1) the mailbox gate, always for the caller's own mailbox.
    await authorize(req.principal, mailbox(tenantId, me), "send");

    // (2) with a context: the client's read, exactly what GET /clients/:clientId sends. The id is passed when it is usable, so the policy
    //     sees the real resource; a malformed context is authorised tenant-wide and refused below as a 400, after the gate.
    const ctx = b.context === undefined || b.context === null ? null : objectOf(b.context);
    const ctxId = ctx && ctx.kind === "client" && typeof ctx.id === "string" && isUuidShaped(ctx.id.trim()) ? ctx.id.trim().toLowerCase() : null;
    if (ctx) await authorize(req.principal, { kind: "client", tenantId, ...(ctxId ? { id: ctxId } : {}) }, "read");

    // (3) only now the body.
    if (ctx && !ctxId) throw sendInvalid("context", "context must be { kind: \"client\", id } with the client's id.");
    const outgoing = parseSendRequest(b);

    // (4) the client must exist in this tenant (another tenant's is hidden by RLS and answers the same 400).
    if (ctxId && !(await clientExists(tenantId, ctxId))) throw sendInvalid("context", "that client does not exist.");

    // (5) the connection, the limit, the send.
    const user = requireUser(req);
    const out = await sendAnswer(tenantId, user, outgoing);

    // The one activity row: `emailed`, on the client when there is a context, else on nobody. Who, when (the row's own time), how many
    // recipients, the mode. NEVER the subject, the body or an address. It follows a send that already happened, so a failure here must not
    // turn a delivered message into an error the person answers by sending again.
    try {
      await writeActivity(tenantId, me, "emailed", ctxId ? "client" : "personal_mailbox", ctxId, { recipientCount: recipientCount(outgoing), mode: out.mode });
    } catch {
      console.warn("[gmail] the emailed activity row could not be written (the message was sent)");
    }
    return out;
  }
}

async function clientExists(tenantId: string, clientId: string): Promise<boolean> {
  const r = await withTenants([tenantId], (c) => c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]));
  return r.rows.length > 0;
}

/** The tenant-agnostic callback at ONE fixed path (Google permits no wildcard redirect URIs); see the header. Live mode only. */
@Controller("api/gmail/oauth")
@UseGuards(AuthGuard)
export class GmailOauthCallbackController {
  @Get("callback")
  async callback(
    @Req() req: FastifyRequest,
    @Query("code") code?: unknown,
    @Query("state") state?: unknown,
    @Query("error") error?: unknown,
  ): Promise<{ mode: "live"; status: "connected"; accountEmail: string } | { mode: "live"; status: "denied"; reason: "gmail_consent_denied" }> {
    // Simulated mode has no Google flow at all: the start route links the simulated mailbox directly, so a callback is never expected.
    if (gmailMode() !== "live") throw gmailError(400, "gmail_state_invalid", "there is no Google connection flow in simulated mode.");
    if (!gmailLiveConfigured()) throw notConfigured();
    // The person declined at Google's consent screen: a normal OAuth outcome, not a refusal of this route.
    if (typeof error === "string" && error) return { mode: "live", status: "denied", reason: "gmail_consent_denied" };
    if (typeof code !== "string" || !code || typeof state !== "string" || !state) {
      throw gmailError(400, "gmail_state_invalid", "the Gmail connection could not be verified; start connecting again.");
    }
    // The signature first (cheap, no DB), so the tenant the Cerbos check runs against is trustworthy; then the surface's own check,
    // BEFORE the state is spent.
    const tenantId = verifiedStateTenant(state);
    const surface = googleSurfaceFor("google_gmail") ?? GOOGLE_GMAIL_SURFACE;
    const me = req.principal.userId ?? "";
    await authorize(req.principal, { kind: surface.authz.kind, tenantId, ownerId: me }, surface.authz.action);
    const out = await completeConnect({ stateToken: state, code, principalUserId: requireUser(req) });
    if (out.status === "denied") return { mode: "live", ...out };
    await writeActivity(tenantId, me, "connected", "integration_connection", out.connectionId, { provider: "google_gmail", mode: "live" });
    return { mode: "live", status: "connected", accountEmail: out.accountEmail };
  }
}
