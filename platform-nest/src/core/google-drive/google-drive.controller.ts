// DW-6i (docs/FRONTEND-BFF-CONTRACT.md §42) — Google Drive: connect, pick and attach. Routes and authorisation only; the flow, the vault
// and Google are in service.ts and client.ts.
//
// ── THERE IS NO NEW CERBOS KIND ──────────────────────────────────────────────────────────────────
//   * connect, disconnect and the Picker read are the person's OWN connection row, so they are `integration_connection` with
//     `ownerId` = the caller (the same self-service rows "My connections" uses, integrations.controller.ts): `create`, `delete`
//     and `read`, each through `connectionAction(..., me, me)`, which is the plain self-tier action for your own row.
//   * attach is authorised exactly as `POST /files`: `file` · `create`, then `read` on the target (`task`).
//
// ── ORDER OF THE ATTACH HANDLER (the DW-5a order, as Figma's) ────────────────────────────────────
//   (1) `file` · `create`; (2) `task` · `read` (with the target's id when it is usable), so a caller who may not read tasks learns
//   nothing, not even whether a task exists; (3) only now the `targetType` list of one (400); (4) the task must exist in this
//   tenant (404 `target_not_found`: RLS hides another tenant's); (5) only now the body is validated (400 `bad_drive_file_id`), so
//   validation never pre-empts a 403; (6) the work.
//
// ── THE CALLBACK ─────────────────────────────────────────────────────────────────────────────────
// Google's redirect is a bare top-level navigation: no Authorization header. So, exactly as search's does, the URL registered as
// Google's `redirect_uri` is a page the FRONT END owns, which reads `code`/`state`/`error` off its own URL and calls THIS route as
// an ordinary authenticated BFF request (AuthGuard: the same browser session that started the flow), then itself redirects the
// person back to where they started with a coarse flag. This route answers a coarse JSON outcome (`connected` / `denied`), never a
// token. It has no `:tenantId`: the tenant and the person come only from the VERIFIED state (core/google-oauth/state.ts attacks
// A1 to A8), and the surface's own Cerbos check runs against that tenant BEFORE the state is spent.
//
// ── ERRORS ───────────────────────────────────────────────────────────────────────────────────────
// A refusal puts its token at the START of `message` (the error filter turns `message` into `{ error }`) and repeats it in
// `reason`: `drive_not_configured`, `drive_not_connected`, `drive_needs_reconnect`, `drive_state_invalid`, `drive_exchange_failed`,
// `drive_file_not_found`, `drive_unavailable`, `drive_already_attached`, `target_not_found`, `unsupported_target_type`,
// `bad_drive_file_id`. No error, log line or activity row ever carries a token (service.ts header).
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize, writeActivity } from "../http";
import { isUuidShaped } from "../dept-resolution";
import { connectionAction } from "../integrations.controller";
import { googleSurfaceFor } from "../google-oauth/registry";
import { GOOGLE_DRIVE_SURFACE } from "./surface";
import {
  ATTACH_TARGET_TYPES, attachDriveFile, completeConnect, disconnect, driveError, isFileId, notConfigured, pickerAnswer, startConnect,
  statusAnswer, taskExists, verifiedStateTenant, type DriveStatusAnswer, type PickerAnswer,
} from "./service";
import { googleDriveConfigured } from "../../config";

const objectOf = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

/** The caller's user id; a connection is a PERSON's, so a principal with none is refused (after the authz gate). */
function requireUser(req: FastifyRequest): string {
  const me = req.principal.userId;
  if (!me) throw driveError(400, "user_required", "an authenticated user is required.");
  return me;
}

@Controller("api")
@UseGuards(AuthGuard)
export class GoogleDriveController {
  /** `{ authUrl }`: where to send the browser for Google's consent screen. `integration_connection` · `create` on the caller's own row. */
  @Get(":tenantId/integrations/google-drive/oauth/start")
  async start(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<{ authUrl: string }> {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: me }, connectionAction("create", me, me));
    return startConnect(tenantId, requireUser(req));
  }

  /** Revokes at Google (best effort, reported) and clears the sealed tokens. Attachments already made stay: they are links. */
  @Delete(":tenantId/integrations/google-drive")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: me }, connectionAction("delete", me, me));
    const out = await disconnect(tenantId, requireUser(req));
    if (out.disconnected) {
      // Never a token: only that it happened and what Google answered.
      await writeActivity(tenantId, me, "disconnected", "integration_connection", out.connectionId, {
        provider: "google_drive", revokedAtGoogle: out.revokedAtGoogle,
      });
    }
    return { disconnected: out.disconnected, revokedAtGoogle: out.revokedAtGoogle };
  }

  /** `{ configured, connected, needsReconnect, accountEmail }` for the caller only: the status without a token, read from the row
   *  alone (Google is never called). The pages that only need to know whether to offer Drive read this, not the Picker read. */
  @Get(":tenantId/integrations/google-drive")
  async status(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string): Promise<DriveStatusAnswer> {
    const me = req.principal.userId ?? "";
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: me }, connectionAction("read", me, me));
    return statusAnswer(tenantId, requireUser(req));
  }

  /** `{ configured, connected, needsReconnect, accountEmail, accessToken, expiresAt, apiKey, appId }` for the caller only. The
   *  ONE route that returns an access token, so `Cache-Control: no-store` is set before anything can fail. */
  @Get(":tenantId/integrations/google-drive/picker")
  async picker(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string,
  ): Promise<PickerAnswer> {
    void reply.header("cache-control", "no-store");
    void reply.header("pragma", "no-cache");
    const me = req.principal.userId ?? "";
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: me }, connectionAction("read", me, me));
    return pickerAnswer(tenantId, requireUser(req));
  }

  /** `{ targetType: "task", targetId, fileId }`: attaches a Drive file to a task as a link. 201 with the file row. */
  @Post(":tenantId/integrations/google-drive/attach")
  @HttpCode(201)
  async attach(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    const b = objectOf(body);
    const targetId = typeof b.targetId === "string" && isUuidShaped(b.targetId.trim()) ? b.targetId.trim().toLowerCase() : null;

    // (1)+(2) exactly as POST /files: `file` · `create`, then `read` on the target.
    await authorize(req.principal, { kind: "file", tenantId }, "create");
    await authorize(req.principal, { kind: "task", tenantId, ...(targetId ? { id: targetId } : {}) }, "read");

    // (3) only now: the list of one.
    const targetType = typeof b.targetType === "string" ? b.targetType : "";
    if (!(ATTACH_TARGET_TYPES as readonly string[]).includes(targetType)) {
      throw driveError(400, "unsupported_target_type", `targetType must be one of: ${ATTACH_TARGET_TYPES.join(", ")}.`);
    }
    // (4) the target must exist in this tenant (another tenant's is hidden by RLS and answers the same 404).
    if (!targetId || !(await taskExists(tenantId, targetId))) throw driveError(404, "target_not_found", "that task does not exist.");
    // (5) only now the rest of the body.
    if (!isFileId(b.fileId)) throw driveError(400, "bad_drive_file_id", "fileId must be a Google Drive file id.");

    const me = requireUser(req);
    return fileRowOf(
      await attachDriveFile({ tenantId, userId: me, targetType: targetType as "task", targetId, fileId: b.fileId }),
    );
  }
}

/** The file row in the shape `GET /files` lists (snake_case), plus the link, so the UI can render and open it. */
function fileRowOf(f: Awaited<ReturnType<typeof attachDriveFile>>) {
  return {
    id: f.id, filename: f.filename, content_type: f.contentType, byte_size: f.byteSize, scrubbed: f.scrubbed,
    uploader_id: f.uploaderId, created_at: f.createdAt, url: f.url,
    target_entity_type: f.targetType, target_entity_id: f.targetId,
  };
}

/** The tenant-agnostic callback at ONE fixed path (Google permits no wildcard redirect URIs); see the header. */
@Controller("api/google-drive/oauth")
@UseGuards(AuthGuard)
export class GoogleDriveOauthCallbackController {
  @Get("callback")
  async callback(
    @Req() req: FastifyRequest,
    @Query("code") code?: unknown,
    @Query("state") state?: unknown,
    @Query("error") error?: unknown,
  ): Promise<{ status: "connected"; accountEmail: string } | { status: "denied"; reason: "drive_consent_denied" }> {
    if (!googleDriveConfigured()) throw notConfigured();
    // The person declined at Google's consent screen: a normal OAuth outcome, not a refusal of this route. Nothing is touched;
    // the unspent state row expires on its own TTL.
    if (typeof error === "string" && error) return { status: "denied", reason: "drive_consent_denied" };
    if (typeof code !== "string" || !code || typeof state !== "string" || !state) {
      throw driveError(400, "drive_state_invalid", "the Google Drive connection could not be verified; start connecting again.");
    }
    // The signature first (cheap, no DB), so the tenant the Cerbos check runs against is trustworthy; then the surface's own check,
    // BEFORE the state is spent, so a person whose right was revoked mid-flow is refused and can retry once re-permissioned.
    const tenantId = verifiedStateTenant(state);
    const surface = googleSurfaceFor("google_drive") ?? GOOGLE_DRIVE_SURFACE;
    const me = req.principal.userId ?? "";
    await authorize(req.principal, { kind: surface.authz.kind, tenantId, ownerId: me }, surface.authz.action);
    const out = await completeConnect({ stateToken: state, code, principalUserId: requireUser(req) });
    if (out.status === "denied") return out;
    // The audit row: that it was connected and through which provider. Never a token, never the email.
    await writeActivity(tenantId, me, "connected", "integration_connection", out.connectionId, { provider: "google_drive" });
    return { status: "connected", accountEmail: out.accountEmail };
  }
}

