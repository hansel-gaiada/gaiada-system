// WSUX-17 (ex-P1-10) — OPTIONAL team seed for the Claude seat registry. Not required by the ticket's
// acceptance criteria (mapping persists/reload, launcher render, team grid list all exercise fine
// against an empty registry); this is a convenience for ops/QA who want a populated team roster to
// look at without clicking through the (not-yet-built, WSUX-16) Connections UI. Distinct from WSUX-10's
// DEMO_MODE frontend fixtures (static JSON for the UI's no-backend demo mode) — this writes REAL rows
// through the real API-backing service layer (claude-seats.service.ts), so it's also useful as a
// smoke check that the registry writes against a live DB.
//
// Idempotent: mapSeat() upserts on the (tenant, owner_kind='user', owner_id, provider='claude')
// UNIQUE, so re-running just re-applies the same seat data rather than erroring or duplicating.
//
// Run after the agency seed: DATABASE_URL=... tsx src/seed/claude-seats.ts [companyName]
import { withGlobal, withTenants, closePool } from "../db";
import { migrate } from "../db/migrate";
import { mapSeat, unmapSeat, listTeamSeats } from "../core/claude-seats.service";

const DEFAULT_COMPANY = "Gaia Digital Agency";

async function findTenant(name: string): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [name]),
  );
  return rows[0]?.id ?? null;
}

async function membersOf(tenantId: string): Promise<Array<{ id: string; email: string }>> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM users u
         JOIN company_memberships m ON m.user_id = u.id
        WHERE m.tenant_id = $1 ORDER BY u.email LIMIT 2`,
      [tenantId],
    ),
  );
  return rows;
}

async function main() {
  const companyName = process.argv[2] ?? DEFAULT_COMPANY;
  await migrate();
  const tenantId = await findTenant(companyName);
  if (!tenantId) {
    console.error(`Company "${companyName}" not found — run the agency seed first.`);
    process.exitCode = 1;
    return;
  }
  const members = await membersOf(tenantId);
  if (members.length === 0) {
    console.error(`No members in "${companyName}" — nothing to seat-map.`);
    process.exitCode = 1;
    return;
  }

  // First member: a fully-mapped seat (Code seat email + Design login).
  const mapped = await mapSeat(tenantId, {
    personId: members[0].id,
    codeSeatEmail: members[0].email,
    designLogin: members[0].email,
    createdBy: null,
  });
  console.log(`mapped   : ${members[0].email} -> ${mapped.id} (mapped=${mapped.mapped})`);

  // Second member (if any): map then unmap, so the DB also has a REVOKED seat row on hand for manual
  // poking (e.g. `?owner=team` won't show it — listTeamSeats excludes revoked rows by default, exactly
  // like the generic connections list — but it's there for anyone testing the includeRevoked path via
  // integrations.service directly). A person who was simply never seat-mapped has NO row at all; that
  // (not a revoked row) is what the console's LauncherRow "Map your seat" empty state represents.
  if (members[1]) {
    const seat = await mapSeat(tenantId, {
      personId: members[1].id,
      codeSeatEmail: members[1].email,
      createdBy: null,
    });
    await unmapSeat(tenantId, seat.id);
    console.log(`revoked  : ${members[1].email} -> ${seat.id} (row kept, excluded from the default roster)`);
  }

  const roster = await listTeamSeats(tenantId);
  console.log(`team roster (mapped, non-revoked) for "${companyName}": ${roster.length} seat row(s)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
