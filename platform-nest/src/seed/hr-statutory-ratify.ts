// Make the statutory parameter set SELF-CONTAINED, then ratify it.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
// Payroll computes but REFUSES to approve a run while `hr_statutory_parameter_sets.ratified_at` is
// NULL. That refusal is correct — approving payroll against numbers nobody has signed off is how a
// company under-withholds tax for a year without noticing — and it is currently the single thing
// blocking an end-to-end payroll run on the live estate.
//
// ── THE SUBTLETY THAT MAKES THIS MORE THAN AN UPDATE STATEMENT ─────────────────────────────────
// ★ `loadStatutoryParams` starts from `DEFAULT_PARAMS_UNRATIFIED` and OVERLAYS whatever the database
// set defines. That is deliberate and documented (a tenant may add this year's BPJS caps before the
// TER tables land). But it means the live set can be missing the TER tables entirely and payroll
// still computes — using the bands hardcoded in `payroll-calc.ts`.
//
// Ratifying a set in that state would attach a human's signature to numbers the set DOES NOT
// CONTAIN. The flag would say "an accountable person approved these rates" while the rates actually
// used came from a TypeScript literal nobody was shown. So this writes the TER tables INTO the set
// first, and only then ratifies — the signature covers the figures the engine will really use.
//
// ── THE BANDS ARE COPIED, NEVER RETYPED ────────────────────────────────────────────────────────
// The TER A/B/C tables are 45 bands of PMK 168/2023. They are imported from `payroll-calc.ts` and
// written verbatim. Re-typing them here would create a second transcription of tax law free to
// disagree with the first, and a wrong band produces a confidently wrong withholding on somebody's
// payslip. One transcription, copied.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
// It does not change any existing rate. Three figures in the live set are questionable and are
// RECORDED AS SUCH on the set's `source_note` rather than silently corrected, because a money number
// changed on a half-remembered figure is worse than a stale one that is flagged:
//
//   • `bpjs.jp.wage_cap` = 10,547,400 — likely superseded; the JP ceiling is periodically uprated.
//   • `bpjs.jkp.employer_rate` = 0.36% — sources disagree (0.36% vs 0.46%) and this is unresolved.
//   • `bpjs.jkk.employer_rate` = 0.24% — the LOWEST risk band (Group I). JKK is set per employer by
//     industry risk class, so this is an assumption about the company, not a national constant.
//
// ── AND THE HONEST PART ────────────────────────────────────────────────────────────────────────
// ⚠ The ratifier is `hansel@gaiada.com`, by explicit owner decision (2026-08-26), as a DEV-STAGE
// PLACEHOLDER. That is a real human being recorded as having approved statutory rates they have not
// audited. The alternative on offer was leaving payroll blocked indefinitely, and the owner chose
// this knowing the trade. The `source_note` says so in the database itself — not only in this
// comment — so anyone reading the ratification later sees what it is without having to find this
// file. See `docs/PLACEHOLDER-PRINCIPALS.md`.
//
// This MUST be re-ratified by the person actually accountable before real employee data is
// processed. That is a Legal Gate 1 condition, not a nicety.
import { withTenants, withGlobal, closePool } from "../db";
import { DEFAULT_PARAMS_UNRATIFIED } from "../modules/hr/payroll-calc";

const RATIFIER_EMAIL = "hansel@gaiada.com";

const SOURCE_NOTE = [
  "DEV-STAGE PLACEHOLDER RATIFICATION (2026-08-26, explicit owner decision).",
  "Ratified by hansel@gaiada.com, who is a superadmin standing in for the accountable person —",
  "NOT an accountant's sign-off. Re-ratify before processing real employee data (Legal Gate 1).",
  "",
  "TER A/B/C written into this set from the engine's transcription of PMK 168/2023, so the",
  "ratification covers the bands actually used rather than relying on a code fallback.",
  "",
  "UNRESOLVED, deliberately not altered here:",
  "- bpjs.jp.wage_cap 10,547,400 may be superseded; the JP ceiling is periodically uprated.",
  "- bpjs.jkp.employer_rate 0.36% — sources conflict (0.36% vs 0.46%).",
  "- bpjs.jkk.employer_rate 0.24% assumes risk Group I; JKK is set per employer by industry class,",
  "  so this is an assumption about this company, not a national constant.",
].join("\n");

export async function ratifyStatutory(): Promise<{
  tenants: number; terWritten: number; ratified: number; skipped: number;
}> {
  const actor = await withGlobal(async (c) => {
    const r = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [RATIFIER_EMAIL]);
    return r.rows[0]?.id ?? null;
  });
  if (!actor) throw new Error(`seed:hr-statutory-ratify — no user ${RATIFIER_EMAIL}; cannot record a ratifier.`);

  const companies = await withGlobal(async (c) => {
    const r = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE deleted_at IS NULL AND 'hr' = ANY(enabled_modules) ORDER BY name`,
    );
    return r.rows;
  });

  let terWritten = 0;
  let ratified = 0;
  let skipped = 0;

  for (const co of companies) {
    await withTenants([co.id], async (c) => {
      const set = await c.query<{ id: string; ratified_at: string | null }>(
        `SELECT id, ratified_at FROM hr_statutory_parameter_sets
          WHERE tenant_id = $1 ORDER BY effective_from DESC LIMIT 1`,
        [co.id],
      );
      const found = set.rows[0];
      if (!found) {
        // No set at all is a DIFFERENT problem from an unratified one, and inventing a set here
        // would hide it. `seed:hr-config` owns creating one.
        console.log(`  ${co.name}: no statutory set — skipped (run seed:hr-config first)`);
        skipped++;
        return;
      }

      // TER tables, copied from the engine's single transcription.
      for (const cat of ["A", "B", "C"] as const) {
        const bands = DEFAULT_PARAMS_UNRATIFIED.ter[cat];
        await c.query(
          `INSERT INTO hr_statutory_parameters (tenant_id, set_id, key, value_json, unit, note)
           -- unit is NULL, not a made-up 'bands'. The column CHECK allows only
           -- rate/amount/months/years/count or NULL, and the one existing JSON-valued
           -- parameter (pph21.brackets) uses NULL. A band table has no single unit; the
           -- rates live inside the JSON. NOTE: no backticks in this comment -- it sits
           -- inside a JS template literal, where a backtick ends the string.
           VALUES ($1,$2,$3,$4::jsonb,NULL,$5)
           -- The unique index is on (tenant_id, set_id, key) — NOT (set_id, key). An ON CONFLICT
           -- target must name a real unique constraint exactly, and the shorter tuple raised
           -- 42P10 against the live database. Checking that "an index mentioning both columns
           -- exists" was not the same question as "a unique index on exactly these columns
           -- exists", and only the second one is what ON CONFLICT accepts.
           ON CONFLICT (tenant_id, set_id, key) DO UPDATE
             SET value_json = EXCLUDED.value_json, note = EXCLUDED.note`,
          [
            co.id, found.id, `pph21.ter.${cat}`, JSON.stringify(bands),
            `PMK 168/2023 TER category ${cat}, ${bands.length} bands. Copied from the engine's `
            + `transcription (payroll-calc.ts) rather than retyped — one transcription of tax law, not two.`,
          ],
        );
        terWritten++;
      }

      // Provenance on the three figures that are questionable, so a reader of the DATA sees the
      // doubt without having to find the seed that wrote it.
      const notes: Array<[string, string]> = [
        ["bpjs.jp.wage_cap", "MAY BE SUPERSEDED — the JP ceiling is periodically uprated. Confirm against the current BPJS circular."],
        ["bpjs.jkp.employer_rate", "UNRESOLVED — sources conflict (0.36% vs 0.46%). Not altered by the placeholder ratification."],
        ["bpjs.jkk.employer_rate", "ASSUMES RISK GROUP I (lowest). JKK is set per employer by industry risk class; confirm this company's band."],
      ];
      for (const [key, note] of notes) {
        await c.query(
          `UPDATE hr_statutory_parameters SET note = $3 WHERE set_id = $1 AND key = $2`,
          [found.id, key, note],
        );
      }

      if (found.ratified_at) {
        console.log(`  ${co.name}: already ratified — TER refreshed, ratification left alone`);
        skipped++;
        return;
      }

      await c.query(
        `UPDATE hr_statutory_parameter_sets
            SET ratified_by = $2, ratified_at = now(), source_note = $3, updated_at = now()
          WHERE id = $1`,
        [found.id, actor, SOURCE_NOTE],
      );
      ratified++;
      console.log(`  ${co.name}: TER written, set RATIFIED (placeholder)`);
    }, { modules: ["hr"] });
  }

  return { tenants: companies.length, terWritten, ratified, skipped };
}

async function main() {
  const r = await ratifyStatutory();
  console.log("");
  console.log(`statutory ratification: ${r.tenants} company(ies), ${r.terWritten} TER table(s) written, `
    + `${r.ratified} set(s) ratified, ${r.skipped} skipped`);
  console.log("");
  console.log("⚠ THIS IS A PLACEHOLDER RATIFICATION recorded against hansel@gaiada.com by owner");
  console.log("  decision. It is NOT an accountant's sign-off. Payroll will now approve runs, and the");
  console.log("  set's source_note says in the database what this signature actually is.");
  console.log("");
  console.log("  Three figures remain unresolved and are flagged on the parameters themselves:");
  console.log("    bpjs.jp.wage_cap        may be superseded");
  console.log("    bpjs.jkp.employer_rate  0.36% vs 0.46% conflict");
  console.log("    bpjs.jkk.employer_rate  assumes risk Group I");
  console.log("");
  console.log("  Re-ratify with the accountable person before real employee data (Legal Gate 1).");
  await closePool();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
