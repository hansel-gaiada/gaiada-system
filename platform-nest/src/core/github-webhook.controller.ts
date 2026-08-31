// GH-07 (docs/blueprints/github-integration-foundation.md §4.5) — `POST /api/webhooks/github`. The
// exact path the live GitHub App is already configured to call (per this ticket's own brief) — it
// 404s until this controller ships.
//
// ── THE SIGNATURE IS THE ENTIRE AUTHENTICATION WALL ─────────────────────────────────────────────────
// This endpoint is INTERNET-FACING. GitHub is not a session holder, so there is no `@UseGuards
// (AuthGuard)` here and no Cerbos `authorize()` call — matching the estate's own established shape
// for an internal, event-driven writer with no HTTP principal
// (`work-activity-ingest.service.ts`'s header: "internal service function, no authorize() call...
// exactly the same shape service-reconciler.ts's reconcile* functions already use"; GH-06's
// `syncGithubRepos` is the same pattern one ticket earlier). HMAC-SHA256 verification
// (github-webhook-signature.ts) against `config.githubWebhookSecret`, timing-safe, over the RAW
// bytes GitHub actually sent (github-webhook-raw-body.ts) IS the authentication — reject
// unsigned/invalid BEFORE the body is ever parsed as JSON.
//
// ── LIVES OUTSIDE `core/github/` ─────────────────────────────────────────────────────────────────
// Same reasoning as `github-repos.controller.ts`'s own header for its own placement, and the two
// sibling files this controller depends on: this ticket's scope forbids touching specific files
// inside `core/github/` (GH-01/GH-02's credential/token surface); none of them are imported here.
//
// ── IDEMPOTENCY ON X-GitHub-Delivery ────────────────────────────────────────────────────────────
// GitHub redelivers (network retry, or a human clicking "Redeliver"). `github_webhook_deliveries`
// (migration 202608311145) has a plain UNIQUE index on `delivery_id`; the claim below is
// `INSERT ... ON CONFLICT (delivery_id) DO NOTHING RETURNING id`, which is atomic under Postgres
// row-level locking — of N concurrent redeliveries of the SAME delivery id (the shape this estate's
// `d14-09-redelivery-storm.test.ts` exercises for a different queue), exactly one INSERT returns a
// row and every other returns none. "No row" means "already seen" — ack (200) without reprocessing,
// never a second write to `github_repos` or a second `work_activity` row for the same delivery.
//
// ── NEVER A 5xx GitHub WOULD RETRY OVER ─────────────────────────────────────────────────────────
// Once the signature and idempotency claim both pass, a handler failure is caught, recorded on the
// delivery row (`status = 'failed'`, `error`), logged, and still acked 200 — same philosophy as the
// mail webhook's own "never a 5xx a provider retry loop into existence" (webhook.controller.ts). The
// delivery id is already claimed at that point, so GitHub redelivering the SAME id would just be
// deduped anyway; a 5xx here would only produce noisy retries that can never succeed differently.
import {
  BadRequestException, Controller, HttpCode, PayloadTooLargeException, Post, Req,
  ServiceUnavailableException, UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { dispatchGithubWebhookEvent } from "./github-webhook-handlers";
import { takeCapturedGithubWebhookBody } from "./github-webhook-raw-body";
import { verifyGithubWebhookSignature } from "./github-webhook-signature";

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export interface GithubWebhookAck {
  ok: boolean;
  duplicate?: boolean;
  note?: string;
}

@Controller("api/webhooks")
export class GithubWebhookController {
  @Post("github")
  @HttpCode(200)
  async receive(@Req() req: FastifyRequest): Promise<GithubWebhookAck> {
    const secret = config.githubWebhookSecret;
    // Fail-closed: an unconfigured secret refuses EVERY request, exactly like
    // config.mail.webhookToken and config.social.webhookSecret elsewhere in this codebase — an
    // endpoint whose ONLY wall is a shared secret must never run with that wall silently absent.
    if (!secret) throw new UnauthorizedException("github webhook receiver not configured");

    const captured = takeCapturedGithubWebhookBody(req);
    if (captured?.overCap) throw new PayloadTooLargeException("github webhook payload too large");
    const raw = captured?.raw ?? Buffer.alloc(0);

    // Reject unsigned/invalid BEFORE parsing the body — verifyGithubWebhookSignature runs over the
    // RAW bytes only; nothing below this line trusts anything about the payload until it passes.
    const signature = firstHeader(req.headers["x-hub-signature-256"]);
    if (!verifyGithubWebhookSignature(raw, signature, secret)) {
      throw new UnauthorizedException("invalid github webhook signature");
    }

    const deliveryId = firstHeader(req.headers["x-github-delivery"]);
    const event = firstHeader(req.headers["x-github-event"]);
    if (!deliveryId || !event) {
      throw new BadRequestException("missing X-GitHub-Delivery or X-GitHub-Event header");
    }

    const tenantId = config.githubRepoSync.tenantId;
    if (!tenantId) {
      // The signature verified, so this IS a genuine GitHub delivery — it just has nowhere to be
      // filed. Loud on purpose (platform-nest/CLAUDE.md's "Boot-time refusals" section argues for
      // catching misconfiguration at boot; this one is only resolvable per-request, matching
      // config.githubRepoSync's own existing per-request resolution — but it must never look like a
      // quiet 200 that actually processed nothing).
      throw new ServiceUnavailableException("github webhook receiver misconfigured: no tenant");
    }

    let payload: unknown;
    try {
      payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      throw new BadRequestException("malformed JSON payload");
    }
    const p = (payload && typeof payload === "object" ? payload : {}) as { repository?: { full_name?: string }; action?: string };

    const claim = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(
        `INSERT INTO github_webhook_deliveries
           (id, tenant_id, delivery_id, event, action, full_name, status, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'received', $7)
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING id`,
        [newId(), tenantId, deliveryId, event, p.action ?? null, p.repository?.full_name ?? null, config.originSite],
      ),
    );
    const deliveryRowId = claim.rows[0]?.id;
    if (!deliveryRowId) {
      return { ok: true, duplicate: true };
    }

    try {
      const result = await dispatchGithubWebhookEvent(tenantId, event, payload);
      await withTenants([tenantId], (c) =>
        c.query(
          `UPDATE github_webhook_deliveries SET status = 'processed', processed_at = now() WHERE id = $1`,
          [deliveryRowId],
        ),
      );
      return { ok: true, note: result.note };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withTenants([tenantId], (c) =>
        c.query(
          `UPDATE github_webhook_deliveries SET status = 'failed', processed_at = now(), error = $2 WHERE id = $1`,
          [deliveryRowId, message],
        ),
      );
      // eslint-disable-next-line no-console
      console.error(`[github-webhook] delivery ${deliveryId} (${event}) failed:`, message);
      return { ok: false, note: message };
    }
  }
}
