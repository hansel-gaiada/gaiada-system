// Resolve the person a seed should attribute its data to: the real employee if we have one, the
// seeded fixture persona only if we do not.
//
// ⚠ WHY THIS EXISTS. `seed:agency` created six fixture actors (`owner@gaiada-creative.test` and
// friends) through an `ensureUser` that looked up `users` by email with NO `deleted_at` filter. Once
// the personas were soft-deleted by `seed:retire-persona-principals`, that lookup still FOUND them
// and handed their ids straight back — so re-running the seed would attribute fresh projects, tasks
// and activity to retired principals and quietly undo the whole cleanup. Nothing would error; the
// ghosts would simply be back on every surface.
//
// Two behaviours together close it:
//
//   1. `resolveSeedActor` prefers the real employee who does that job now, so on any database that
//      has the roster the seeds stop creating fixture people at all.
//   2. `assertNotRetired` makes reusing a soft-deleted principal a LOUD failure rather than a silent
//      resurrection, for any path that still reaches `users` by email.
//
// ⚠ THE MAPPING IS `REASSIGN`, NOT A SECOND COPY OF IT. The functional successor of each persona was
// already decided once — by function, from the roster's titles — when their work was moved. A second
// table here would be free to disagree with the first, and the disagreement would show up as data
// attributed to one person and history attributed to another.
import { withGlobal } from "../db";
import { REASSIGN } from "./reassign-retired";

/** The real employee who does this persona's job now, or null if the roster is not seeded here (a
 *  fresh test database), in which case the caller should fall back to the fixture. */
export async function resolveSeedActor(fixtureEmail: string): Promise<string | null> {
  const successor = REASSIGN[fixtureEmail];
  if (!successor) return null;
  const r = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [successor]),
  );
  return r.rows[0]?.id ?? null;
}

/** Refuse to hand back a retired principal.
 *
 *  The alternative — clearing `deleted_at` so the row is usable again — is exactly the resurrection
 *  this module exists to prevent, and it would be invisible: the seed would report success and the
 *  ERP would list an invented person again. Failing tells whoever ran it that the seed needs a real
 *  actor, which is a fixable problem rather than a silent regression. */
export function assertNotRetired(email: string, deletedAt: Date | string | null): void {
  if (deletedAt === null) return;
  throw new Error(
    `seed: "${email}" is a RETIRED principal (users.deleted_at set) — refusing to attribute new data ` +
      `to it. A seed that reuses a retired persona silently resurrects it on every surface. Map it to ` +
      `a real employee in REASSIGN, or seed the roster first (seed:roster-access).`,
  );
}
