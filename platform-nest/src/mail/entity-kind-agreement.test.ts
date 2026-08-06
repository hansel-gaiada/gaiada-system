// MAIL-33 — the check that was missing. `pipeline_gate` was WRITTEN by the tap (MAIL-05's
// `tap.test.ts` pins `row.entity_type === "pipeline_gate"`, driven from a real `openGate` call) and
// REJECTED by thread-authz's own accepted-kind allowlist (`MAIL_THREAD_ENTITY_KINDS`, `thread-
// authz.ts`) — two halves of one feature, each with a passing test, neither checking the other. This
// file is that missing check, in two layers:
//
//  1. A STATIC list of every entity kind a REAL (non-test) `notify()` call site can hand the tap
//     under one of its two allowlisted notification types — audited by hand against
//     `core/approval-filing.ts`, `modules/hr/{hr,loans}.controller.ts`,
//     `modules/search/search.controller.ts` (all `approval.requested` -> `automation_approval`),
//     `modules/agency/agency.controller.ts` (`approval.requested` -> `agency_approval`), and
//     `core/pipeline.controller.ts` (`pipeline.gate.opened` -> `pipeline_gate`) — asserted a SUBSET
//     of `MAIL_THREAD_ENTITY_KINDS`, not equal to it: thread-authz is allowed to accept a kind ahead
//     of a live writer existing for it (`pipeline_run` is exactly that today — accepted, but no
//     current allowlisted-type call site stamps it), the dangerous direction is only the tap writing
//     a kind thread-authz does NOT accept.
//  2. A BEHAVIOURAL guard on `mailIntake` itself (post-MAIL-33, `intake.ts` imports and filters
//     against `MAIL_THREAD_ENTITY_KINDS` directly rather than keeping a second list) — proving the
//     agreement is now structural, not just documented: a bogus fifth kind gets nulled at write time
//     instead of landing an unreadable row that would 403 an admin page exactly like this ticket's
//     defect did.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { config } from "../config";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";
import { MAIL_THREAD_ENTITY_KINDS } from "./thread-authz";
import { mailIntake } from "./intake";

// Hand-audited, not derived by scanning source at test time: a scan can't distinguish "this notify()
// call's `type` argument is one of the two allowlisted literals" from any other `entityType:` in the
// codebase (the notification's TYPE, not its entityType, gates whether the tap ever sees it at all —
// see `intake.ts`'s `MAIL_NOTIFICATION_TYPES`). Keeping this list by hand, next to the audit trail in
// the comment above, is the same posture `thread-authz.ts` itself takes for its own set: "adding a
// kind is a deliberate, visible change", not an inference.
const TAP_WRITABLE_ENTITY_KINDS = new Set(["automation_approval", "agency_approval", "pipeline_gate"]);

describe("mail — MAIL-33 tap-writable / thread-authz-accepted entity kind agreement", () => {
  it("every entity kind a real allowlisted notify() call site can write is accepted by thread-authz", () => {
    for (const kind of TAP_WRITABLE_ENTITY_KINDS) {
      expect(MAIL_THREAD_ENTITY_KINDS.has(kind)).toBe(true);
    }
  });

  it("pipeline_gate specifically — the exact regression this ticket fixes", () => {
    // Before MAIL-33: `MAIL_THREAD_ENTITY_KINDS` was {automation_approval, agency_approval,
    // pipeline_run} — this line would have failed, which is the point.
    expect(MAIL_THREAD_ENTITY_KINDS.has("pipeline_gate")).toBe(true);
  });
});

describe.skipIf(!TEST_URL)("mail — MAIL-33 mailIntake only ever stamps an accepted entity kind (structural, not just documented)", () => {
  let co: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.mail.enabled = true;
    co = await createCompany("Entity Kind Agreement Co");
    admin = await createUser("agreement-admin@a.test");
    await addMembership(co, admin);
  });
  afterAll(async () => {
    config.mail.enabled = false;
    await teardownTestDb();
  });
  afterEach(async () => {
    await adminPool().query(`DELETE FROM mail_log`);
  });

  async function lastMailLogRow(userId: string): Promise<{ entity_type: string | null; entity_id: string | null }> {
    const res = await adminPool().query(
      `SELECT entity_type, entity_id FROM mail_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return res.rows[0];
  }

  it("a REAL, accepted entity kind (pipeline_gate) is preserved on the written row", async () => {
    const gateId = "11111111-1111-1111-1111-111111111111";
    await mailIntake({
      notificationId: "22222222-2222-2222-2222-222222222222",
      tenantId: co,
      userId: admin,
      type: "pipeline.gate.opened",
      payload: { title: "Sign this", href: "/portal/approvals/run-1", entityType: "pipeline_gate", entityId: gateId },
    });
    const row = await lastMailLogRow(admin);
    expect(row).toMatchObject({ entity_type: "pipeline_gate", entity_id: gateId });
  });

  it("an UNRECOGNIZED entity kind is nulled at write time, not stored as an unreadable ref (the guard this ticket adds)", async () => {
    await mailIntake({
      notificationId: "33333333-3333-3333-3333-333333333333",
      tenantId: co,
      userId: admin,
      type: "approval.requested",
      payload: { title: "Some future kind", href: "/somewhere", entityType: "some_future_entity_kind_nobody_taught_thread_authz", entityId: "44444444-4444-4444-4444-444444444444" },
    });
    const row = await lastMailLogRow(admin);
    // Never a half-known ref: an unrecognized type drops BOTH fields, matching the pre-existing
    // "entity-less mail" posture (NDR / auth-stream mail) — admin-only, not a crash.
    expect(row).toMatchObject({ entity_type: null, entity_id: null });
  });

  it("a stray entityId next to a missing/unrecognized entityType is also dropped, not stored orphaned", async () => {
    await mailIntake({
      notificationId: "55555555-5555-5555-5555-555555555555",
      tenantId: co,
      userId: admin,
      type: "approval.requested",
      payload: { title: "No type at all", href: "/somewhere", entityId: "66666666-6666-6666-6666-666666666666" },
    });
    const row = await lastMailLogRow(admin);
    expect(row).toMatchObject({ entity_type: null, entity_id: null });
    await withTenants([co], (c) => c.query(`SELECT 1`)); // no-op; keeps the import honest
  });
});
