// Test seeding shared by the IT functional readers' database tests (DW-7j: f10, f11, f12). Not a test file.
// Every helper writes through the app role (RLS-bound): the IT tables under the tenant wall alone (as IT's own controller does), the
// HR tables under the `hr` wall. Timestamps are passed in by the test (build them with `at()` from dept-kpi-seed.ts) so a boundary
// never assumes the zone.
import { config } from "../config";
import { newId, withTenants } from "../db";
import { createUser } from "./fixtures";
import { withHr } from "./hr-kpi-seed";

export type DeviceEventType = "registered" | "online" | "offline" | "degraded" | "alert" | "heartbeat";

/** One device registered at `created`. Returns its id. */
export async function seedDevice(tenant: string, o: { created: Date; deleted?: boolean; name?: string }): Promise<string> {
  const id = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO it_devices (id, tenant_id, name, origin_site, created_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenant, o.name ?? `dev-${id.slice(0, 8)}`, config.originSite, o.created, o.deleted ? new Date("2026-09-15T00:00:00Z") : null],
    ),
  );
  return id;
}

/** A device with its events, as [type, instant] pairs. */
export async function seedDeviceWithEvents(
  tenant: string,
  o: { created: Date; deleted?: boolean },
  events: Array<[DeviceEventType, Date]> = [],
): Promise<string> {
  const id = await seedDevice(tenant, o);
  for (const [type, at] of events) await seedDeviceEvent(tenant, id, type, at);
  return id;
}

export async function seedDeviceEvent(tenant: string, device: string, type: DeviceEventType, occurredAt: Date): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO it_device_events (id, tenant_id, device_id, type, occurred_at, origin_site) VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), tenant, device, type, occurredAt, config.originSite],
    ),
  );
}

export interface LeaverSeed {
  tenant: string;
  /** The person's login (a `users` row). `null` is a leaver with no login at all. */
  user: string | null;
  /** `employees.user_id`: defaults to `user`. Pass `null` with `user` set to put the login on the separation alone, or the reverse for the fallback. */
  employeeUser?: string | null;
  /** The separation's own `subject_user_id`: defaults to `user`. */
  subjectUser?: string | null;
  /** ISO date. */
  effectiveOn: string;
  status?: "draft" | "pending_approval" | "approved" | "completed" | "cancelled";
  deleted?: boolean;
  actor: string;
}

/** One employee plus their separation (a LIVE separation is unique per employee, so every leaver gets their own). */
export async function seedLeaver(s: LeaverSeed): Promise<void> {
  const employeeUser = s.employeeUser === undefined ? s.user : s.employeeUser;
  const subjectUser = s.subjectUser === undefined ? s.user : s.subjectUser;
  await withHr(s.tenant, async (c) => {
    const emp = await c.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, user_id, display_name, hire_date, created_by) VALUES ($1,$2,$3,'2020-01-01',$4) RETURNING id`,
      [s.tenant, employeeUser, `Leaver ${newId().slice(0, 8)}`, s.actor],
    );
    await c.query(
      `INSERT INTO hr_separations (tenant_id, employee_id, subject_user_id, ground, effective_on, status, created_by, deleted_at, origin_site)
       VALUES ($1,$2,$3,'resignation',$4::date,$5,$6,$7,$8)`,
      [
        s.tenant, emp.rows[0].id, subjectUser, s.effectiveOn, s.status ?? "approved", s.actor,
        s.deleted ? new Date("2026-09-15T00:00:00Z") : null, config.originSite,
      ],
    );
  });
}

/** An activity row as `it-accounts.controller.ts` writes it, at a chosen instant. `verb` defaults to the disable. */
export async function seedAccountActivity(
  tenant: string,
  user: string,
  occurredAt: Date,
  o: { verb?: string; entityType?: string } = {},
): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, occurred_at, origin_site)
       VALUES ($1,$2,NULL,$3,$4,$5,'{}',$6,$7)`,
      [newId(), tenant, o.verb ?? "it.account.disable", o.entityType ?? "it_account", user, occurredAt, config.originSite],
    ),
  );
}

/** A user for a leaver. */
export const seedLeaverUser = (tag: string): Promise<string> => createUser(`${tag}@dw7jit.test`);
