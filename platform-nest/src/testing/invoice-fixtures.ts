// PV5-F1: invoice fixtures for "a pre-PV-5 invoice the client can see".
//
// Since PV5-F1 a `void` invoice is client-visible only if it was issued OR carries `pre_pv5_legacy`, and since PV5-04 a
// `sent`/`paid` invoice must be issued. A fixture that wants "a portal-visible invoice without going through issue" is
// therefore a LEGACY row. The flag can be set by nothing but a migration (a guard trigger refuses every INSERT/UPDATE
// that sets or changes it), so the fixture steps over the trigger the way the migration does: a superuser connection
// with `session_replication_role = replica`, inside one transaction, which affects no other connection.
import { adminPool } from "./setup";

/** Flag already-inserted invoices as pre-PV-5 legacy rows. Call it AFTER the inserting transaction has committed. */
export async function markInvoicesLegacy(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const k = await adminPool().connect();
  try {
    await k.query("BEGIN");
    await k.query("SET LOCAL session_replication_role = replica");
    const r = await k.query(`UPDATE invoices SET pre_pv5_legacy = true WHERE id = ANY($1::uuid[])`, [ids]);
    if (r.rowCount !== ids.length) throw new Error(`markInvoicesLegacy: flagged ${r.rowCount} of ${ids.length} invoices`);
    await k.query("COMMIT");
  } catch (e) {
    await k.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    k.release();
  }
}
