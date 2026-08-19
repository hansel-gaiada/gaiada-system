// SMM-13 — tests for social post event handlers (notifications + mail routing)
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { config } from "../../config";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import type { OutboxEvent } from "../../events/types";
import { handlePostDispatched, handlePostPublished, handlePostFailed } from "./event-handlers";

let seq = 0;
const uniq = (label: string): string => `smm13-event-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-13 · social post event handlers", () => {
  let tenantId: string;
  let engagementId: string;
  let variantId: string;
  let ownerUserId: string;
  let MODULES: { modules: string[] };

  // `config.mail.enabled` is the master gate: with it off, enqueueMail returns {skipped} WITHOUT
  // touching mail_log, so a mail assertion silently reads 0 and looks like a routing bug. Flipped
  // here and restored in afterAll, the idiom mail/queue.test.ts already established.
  const savedMailEnabled = config.mail.enabled;

  beforeAll(async () => {
    config.mail.enabled = true;
    await initTestDb();
    MODULES = { modules: ["social"] };
    tenantId = await createCompany("SMM-13 Event Handler Test", ["social"]);

    // Create a user (the engagement owner)
    ownerUserId = await createUser(uniq("owner@test.com"));
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO company_memberships (id, tenant_id, user_id, status, origin_site, kind)
         VALUES ($1, $2, $3, 'active', 'central', 'employee')`,
        [newId(), tenantId, ownerUserId],
      ));

    // Create a client
    const clientId = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1, $2, $3, 'central')`,
        [clientId, tenantId, uniq("client")],
      ));

    // Create an engagement with the user as owner
    engagementId = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', '{}', 10, 'central')`,
        [engagementId, tenantId, clientId, uniq("engagement"), ownerUserId],
      ), MODULES);

    // Create a post and variant
    const postId = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1, $2, $3, 'Test Post', 'approved', 'central')`,
        [postId, tenantId, engagementId],
      ), MODULES);

    // Create a publisher org
    const publisherOrgId = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [publisherOrgId, tenantId, clientId, uniq("org")],
      ), MODULES);

    // Create a social account
    const accountId = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1, $2, $3, $4, 'instagram', 'test_handle', $5, 'connected', '{}', 'central')`,
        [accountId, tenantId, clientId, publisherOrgId, uniq("ig-integration")],
      ), MODULES);

    variantId = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_post_variants (id, post_id, tenant_id, account_id, body, status, origin_site)
         VALUES ($1, $2, $3, $4, 'Test variant', 'approved', 'central')`,
        [variantId, postId, tenantId, accountId],
      ), MODULES);
  });

  afterAll(async () => {
    config.mail.enabled = savedMailEnabled;
    await teardownTestDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handlePostDispatched creates notification (not mail)", async () => {
    const event: OutboxEvent = {
      id: newId(),
      tenantId,
      entityType: "social_post_variant",
      entityId: variantId,
      eventType: "social.post.dispatched",
      payload: {
        network: "instagram",
        engagementId,
        providerPostId: "provider-123",
      },
      originSite: "central",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    let error: Error | null = null;
    try {
      await handlePostDispatched(event);
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeNull();

    // Assert notification was created
    const { rows: notifRows } = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT type, payload FROM notifications WHERE user_id = $1 AND type = 'social.post.dispatched' ORDER BY created_at DESC LIMIT 1`,
        [ownerUserId],
      ));
    expect(notifRows.length).toBe(1);
    const notif = notifRows[0];
    expect(notif.type).toBe("social.post.dispatched");
    const notifPayload = (notif.payload as Record<string, unknown>);
    expect(notifPayload.severity).toBe("info");
    expect(notifPayload.title).toContain("instagram");

    // Assert NO mail was queued (routine success must not trigger mail)
    const { rows: mailRows } = await adminPool().query(
      `SELECT COUNT(*) as count FROM mail_log WHERE template_key = 'social.post_dispatched'`,
    );
    expect(Number(mailRows[0].count)).toBe(0);
  });

  it("handlePostPublished creates notification (not mail)", async () => {
    const event: OutboxEvent = {
      id: newId(),
      tenantId,
      entityType: "social_post_variant",
      entityId: variantId,
      eventType: "social.post.published",
      payload: {
        network: "instagram",
        engagementId,
        providerPostId: "provider-456",
      },
      originSite: "central",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    await handlePostPublished(event);

    // Assert notification was created
    const { rows: notifRows } = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT type, payload FROM notifications WHERE user_id = $1 AND type = 'social.post.published' ORDER BY created_at DESC LIMIT 1`,
        [ownerUserId],
      ));
    expect(notifRows.length).toBe(1);
    const notif = notifRows[0];
    expect(notif.type).toBe("social.post.published");
    const notifPayload = (notif.payload as Record<string, unknown>);
    expect(notifPayload.severity).toBe("info");
    expect(notifPayload.title).toContain("instagram");

    // Assert NO mail was queued (routine success must not trigger mail)
    const { rows: mailRows } = await adminPool().query(
      `SELECT COUNT(*) as count FROM mail_log WHERE template_key = 'social.post_published'`,
    );
    expect(Number(mailRows[0].count)).toBe(0);
  });

  it("handlePostFailed creates notification AND queues mail with refusal token", async () => {
    const event: OutboxEvent = {
      id: newId(),
      tenantId,
      entityType: "social_post_variant",
      entityId: variantId,
      eventType: "social.post.failed",
      payload: {
        network: "instagram",
        engagementId,
        reason: "dispatch_error",
        detail: "Network timeout",
      },
      originSite: "central",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    await handlePostFailed(event);

    // Assert notification was created with critical severity and refusal token
    const { rows: notifRows } = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT type, payload FROM notifications WHERE user_id = $1 AND type = 'social.post.failed' ORDER BY created_at DESC LIMIT 1`,
        [ownerUserId],
      ));
    expect(notifRows.length).toBe(1);
    const notif = notifRows[0];
    expect(notif.type).toBe("social.post.failed");
    const notifPayload = (notif.payload as Record<string, unknown>);
    expect(notifPayload.severity).toBe("critical");
    expect(notifPayload.title).toContain("failed");
    // Assert refusal token survives in payload (not flattened)
    expect(notifPayload.reason).toBe("dispatch_error");

    // Assert mail was queued with social.post_failed template
    const { rows: mailRows } = await adminPool().query(
      `SELECT template_key, payload FROM mail_log WHERE template_key = 'social.post_failed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(mailRows.length).toBeGreaterThan(0);
    const mail = mailRows[0];
    expect(mail.template_key).toBe("social.post_failed");
    const mailPayload = (mail.payload as Record<string, unknown>);
    // Assert refusal token also survives in mail payload
    expect(mailPayload.reason).toBe("Dispatch Error"); // Token humanized for mail
    expect(mailPayload.detail).toBe("Network timeout");
  });

  it("handles missing engagement gracefully (no-op)", async () => {
    const noopEntityId = newId();
    const event: OutboxEvent = {
      id: newId(),
      tenantId,
      entityType: "social_post_variant",
      // A DISTINCT entity id on purpose: the dispatched test above already notified on `variantId`,
      // so counting by that id could never reach 0 once the handlers actually work -- the assertion
      // would pass only while the feature was broken.
      entityId: noopEntityId,
      eventType: "social.post.dispatched",
      payload: {
        network: "instagram",
        engagementId: newId(), // non-existent engagement
        providerPostId: "provider-789",
      },
      originSite: "central",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    // Should not throw
    await handlePostDispatched(event);

    // No notification should be created (the engagement does not exist)
    const { rows } = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT COUNT(*) as count FROM notifications
          WHERE type = 'social.post.dispatched' AND payload->>'entityId' = $1`,
        [noopEntityId],
      ));
    expect(Number(rows[0].count)).toBe(0);
  });

  it("handles missing event payload gracefully (no-op)", async () => {
    const event: OutboxEvent = {
      id: newId(),
      tenantId,
      entityType: "social_post_variant",
      entityId: variantId,
      eventType: "social.post.dispatched",
      payload: {}, // no engagementId
      originSite: "central",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    // Should not throw
    await handlePostDispatched(event);
  });
});
