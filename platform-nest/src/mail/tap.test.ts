// MAIL-05 — the approval/risk email tap (design §7.2/§7.4; plan row MAIL-05). Covers, per the
// ticket's AC list:
//   1. `pipeline.gate.opened` via a REAL notify() call site (pipeline.controller.ts opening a
//      client-actionable gate) ⇒ exactly one mail_log row carrying the notification's tenant +
//      entity ref + a fresh reply_token.
//   2. The allowlist is EXACTLY {approval.requested, pipeline.gate.opened} — `mention`, `comment`,
//      and `approval_decided` produce ZERO mail_log rows even though they still land a bell
//      notification (probed by calling notify() directly with those types).
//   3. M12 wording-class routing: automation/agent origin ⇒ `approval.warning`;
//      hr/agency/pipeline/unspecified ⇒ `approval.actionable` — asserted on the ENQUEUED row's
//      `template_key`, then RE-RENDERED from that row's own persisted payload (not a hand-crafted
//      test payload) to re-pin the M12 "never implies execution" wording gate end-to-end through
//      the real tap, not just at the template layer (templates.test.ts already covers the template
//      layer in isolation).
//   4. Fail-soft: a forced failure inside the mail tap must never fail the notify() call, and must
//      never fail the HTTP write that triggered it.
//   5. Links are plain entity URLs built from `MAIL_LINK_BASE_URL` — no token, no action params, no
//      literal domain.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createClient, createRole, grantRole } from "../testing/fixtures";
import { renderTemplate } from "./templates";

// vi.mock's factory is hoisted above these imports; vi.hoisted() is vitest's supported escape
// hatch for a value the hoisted factory needs to read LATER, per-test (same pattern
// core/client-notifications.test.ts uses to force notify() itself to fail — here the forced
// failure is one level deeper, inside the mail tap's own enqueue primitive, so the assertion is
// "notify() still doesn't throw" rather than "the caller's try/catch around notify() caught it").
const mailControl = vi.hoisted(() => ({ forceEnqueueFailure: false }));

vi.mock("./queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue")>();
  return {
    ...actual,
    enqueueMail: vi.fn(async (...args: Parameters<typeof actual.enqueueMail>) => {
      if (mailControl.forceEnqueueFailure) throw new Error("forced enqueueMail failure (test)");
      return actual.enqueueMail(...args);
    }),
  };
});

// Imported after the mock declaration for readability (vi.mock's hoisting makes every module that
// reaches ./queue — intake.ts, and therefore core/http.ts's notify() — get the mocked version
// regardless of import order; matches core/client-notifications.test.ts's own convention).
import { notify } from "../core/http";
import { buildApp } from "../main";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function addClientContact(
  tenantId: string,
  clientId: string,
  userId: string,
  opts: { capability?: string } = {},
): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [newId(), tenantId, clientId, userId, opts.capability ?? "signer", config.originSite],
    ),
  );
}

async function mailLogRowsFor(userId: string): Promise<Array<{ template_key: string; payload: Record<string, unknown>; entity_type: string | null; entity_id: string | null; tenant_id: string | null; reply_token: string | null; to_email: string }>> {
  const res = await adminPool().query(
    `SELECT template_key, payload, entity_type, entity_id, tenant_id, reply_token, to_email FROM mail_log WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return res.rows;
}

describe.skipIf(!TEST_URL)("mail — MAIL-05 approval/risk tap", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.mail.enabled = true;
    co = await createCompany("Mail Tap Test Co");
    admin = await createUser("tap-admin@a.test");
    await addMembership(co, admin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => {
    config.mail.enabled = false;
    await app.close();
    await teardownTestDb();
  });
  afterEach(async () => {
    mailControl.forceEnqueueFailure = false;
    await adminPool().query(`DELETE FROM mail_log`);
  });

  // ---- 1. pipeline.gate.opened via the real endpoint ----

  it("opening a client-actionable gate ⇒ exactly one mail_log row with the notification's tenant + entity ref + a fresh reply_token", async () => {
    const contact = await createUser("tap-gate-contact@acme.test");
    const clientRow = await createClient(co, "Tap Client");
    await addClientContact(co, clientRow, contact);

    const run = (
      await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "Tap run", clientId: clientRow },
      })
    ).json().id;

    const before = await mailLogRowsFor(contact);
    const gate = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
      payload: { runId: run, kind: "prd_sign", actorSide: "client" },
    });
    expect(gate.statusCode).toBe(201);
    const gateId = gate.json().id;

    const after = await mailLogRowsFor(contact);
    expect(after.length).toBe(before.length + 1);
    const row = after[0];
    expect(row.template_key).toBe("approval.actionable"); // pipeline origin — deciding today advances the run
    expect(row.tenant_id).toBe(co);
    expect(row.entity_type).toBe("pipeline_gate");
    expect(row.entity_id).toBe(gateId);
    expect(row.reply_token).not.toBeNull();
    expect((row.reply_token as string).length).toBeGreaterThanOrEqual(20);
    expect(row.to_email).toBe("tap-gate-contact@acme.test");
  });

  // ---- 2. the allowlist is EXACTLY two types ----

  describe("allowlist — everything except approval.requested/pipeline.gate.opened produces zero mail", () => {
    it("mention ⇒ zero mail_log rows (bell notification still lands)", async () => {
      const recipient = await createUser("tap-mention@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "mention", { title: "You were mentioned", href: "/tasks/1" });
      expect(await mailLogRowsFor(recipient)).toEqual([]);
      const bell = await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'mention'`, [recipient]);
      expect(bell.rows[0].n).toBe(1);
    });

    it("comment ⇒ zero mail_log rows", async () => {
      const recipient = await createUser("tap-comment@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "comment", { title: "New comment", href: "/tasks/1" });
      expect(await mailLogRowsFor(recipient)).toEqual([]);
    });

    it("approval_decided ⇒ zero mail_log rows", async () => {
      const recipient = await createUser("tap-decided@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "approval_decided", { title: "Your request was decided", href: "/approvals" });
      expect(await mailLogRowsFor(recipient)).toEqual([]);
    });

    it("approval.requested DOES mail (positive control proving the allowlist checks the type, not just 'anything approval-shaped')", async () => {
      const recipient = await createUser("tap-requested@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "approval.requested", {
        title: "update campaign budget", href: "/approvals", origin: "hr",
      });
      expect((await mailLogRowsFor(recipient)).length).toBe(1);
    });
  });

  // ---- 3. M12 wording-class routing, re-pinned on the ENQUEUED row's own rendered output ----

  describe("wording class by origin (M12) — re-asserted on the real enqueued+rendered output", () => {
    it("automation origin ⇒ approval.warning, and the RENDERED output never implies execution", async () => {
      const recipient = await createUser("tap-warn-automation@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "approval.requested", {
        title: "raise ad budget by 40%", href: "/approvals", origin: "automation",
        tool: "budget-optimizer", impact: "high", companyName: "Acme",
      });
      const [row] = await mailLogRowsFor(recipient);
      expect(row.template_key).toBe("approval.warning");
      const rendered = renderTemplate(row.template_key, row.payload);
      const haystack = `${rendered.subject} ${rendered.text} ${rendered.html}`.toLowerCase();
      for (const forbidden of ["approve", "approved", "reject", "rejected", "decide", "deciding"]) {
        expect(haystack).not.toContain(forbidden);
      }
      expect(rendered.text).toContain("nothing has run");
    });

    it("agent origin ⇒ approval.warning (same D14 gap as automation)", async () => {
      const recipient = await createUser("tap-warn-agent@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "approval.requested", {
        title: "delete stale campaign", href: "/approvals", origin: "agent", impact: "medium",
      });
      const [row] = await mailLogRowsFor(recipient);
      expect(row.template_key).toBe("approval.warning");
    });

    it("hr origin ⇒ approval.actionable (deciding today applies the leave decision — WSD-4)", async () => {
      const recipient = await createUser("tap-actionable-hr@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "approval.requested", { title: "leave request", href: "/approvals", origin: "hr" });
      const [row] = await mailLogRowsFor(recipient);
      expect(row.template_key).toBe("approval.actionable");
    });

    it("agency origin ⇒ approval.actionable (the review state change IS the effect)", async () => {
      const recipient = await createUser("tap-actionable-agency@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "approval.requested", { title: "review brief", href: "/approvals", origin: "agency" });
      const [row] = await mailLogRowsFor(recipient);
      expect(row.template_key).toBe("approval.actionable");
    });

    it("missing/unrecognized origin defaults to approval.actionable (never guesses the warning class)", async () => {
      const recipient = await createUser("tap-actionable-default@a.test");
      await addMembership(co, recipient);
      await notify(co, recipient, admin, "approval.requested", { title: "something", href: "/approvals" });
      const [row] = await mailLogRowsFor(recipient);
      expect(row.template_key).toBe("approval.actionable");
    });
  });

  // ---- 4. fail-soft: the mail tap must never break the write it is announcing ----

  describe("fail-soft (design A5/§7.2) — a mail failure must never fail the calling write", () => {
    it("notify() itself resolves (does not throw) when the tap's enqueue primitive throws, and the bell notification still commits", async () => {
      const recipient = await createUser("tap-failsoft-direct@a.test");
      await addMembership(co, recipient);
      mailControl.forceEnqueueFailure = true;
      await expect(
        notify(co, recipient, admin, "approval.requested", { title: "thing", href: "/approvals", origin: "automation" }),
      ).resolves.toBeUndefined();
      const bell = await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'approval.requested'`, [recipient]);
      expect(bell.rows[0].n).toBe(1);
      // The mock fired (enqueueMail threw before writing), proving this isn't a false pass:
      expect(await mailLogRowsFor(recipient)).toEqual([]);
    });

    it("an HTTP write that triggers the tap still returns 2xx when the mail enqueue throws", async () => {
      const contact = await createUser("tap-failsoft-http@acme.test");
      const clientRow = await createClient(co, "Tap Failsoft Client");
      await addClientContact(co, clientRow, contact);
      const run = (
        await app.inject({
          method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
          payload: { title: "Failsoft run", clientId: clientRow },
        })
      ).json().id;

      mailControl.forceEnqueueFailure = true;
      const gate = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin),
        payload: { runId: run, kind: "prd_sign", actorSide: "client" },
      });
      expect(gate.statusCode).toBe(201);
      const row = await adminPool().query(`SELECT status FROM pipeline_gates WHERE id = $1`, [gate.json().id]);
      expect(row.rows[0].status).toBe("pending");
      expect(await mailLogRowsFor(contact)).toEqual([]); // proves the mock fired, not a false pass
    });
  });

  // ---- 5. links: plain entity URLs, no token, no action params, no literal domain ----

  it("the enqueued row's href is an absolute link built from MAIL_LINK_BASE_URL with no query string, no reply_token embedded, and no literal domain", async () => {
    const recipient = await createUser("tap-link@a.test");
    await addMembership(co, recipient);
    await notify(co, recipient, admin, "approval.requested", { title: "thing", href: "/approvals", origin: "hr" });
    const [row] = await mailLogRowsFor(recipient);
    const href = row.payload.href as string;
    expect(href).toBe(`${config.mail.linkBaseUrl}/approvals`);
    expect(href).not.toMatch(/[?&]/); // no query string — no action params, no token param
    expect(href).not.toContain(row.reply_token as string); // the reply token never rides in the link itself
    expect(href).toMatch(/^https:\/\/erp\.gaiada\.invalid\//); // A12: reserved-TLD config default, never a real domain
  });
});
