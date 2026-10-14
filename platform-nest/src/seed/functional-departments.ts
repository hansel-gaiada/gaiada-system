// DW-7d (owner ruling DW-D6): give every existing company HR, Finance and IT departments in its org
// tree, so the HR / Finance / IT workspaces are real departments. One-off backfill; new companies get
// them at creation (company-crud.controller.ts), and seeds through `ensureFunctionalDepartments`.
//
// Dry run by DEFAULT (`node dist/seed/functional-departments.js`); `--apply` writes. Exit code 1 when
// any company has a conflict. Additive only: the three nodes are appended to the root and nothing else
// in the tree changes. Every write goes through `applyOrgStructure` (closure rebuild, membership sweep,
// `org_structure.updated` event, one transaction per company).
//
// ⚠ THE SANITIZE TRAP. `loadOrgStructure` sanitizes on read, and seeds (agency.ts) insert trees directly,
// without `assigneeId`/`assigneeName` on department nodes. Writing back a SANITIZED tree would silently
// change every one of those nodes. So this works on the RAW stored blob and appends to it. Because
// `applyOrgStructure` then builds the closure from what we hand it, a raw tree the sanitizer would have
// rewritten (renamed duplicate ids, coerced kinds, trimmed names, truncated depth/size) is REFUSED with
// a conflict instead: the rewrite is the org builder's job, not a backfill's.
//
// Node ids are per company (`functionalNodeId`), so the LMS courses/paths that the LMS seeds put on the
// shared legacy unit ids `d-hr` / `d-it` are re-pointed to the company's own node in the same
// transaction (lms_courses.unit_node_id, lms_paths.unit_node_id), but only when this company's tree
// holds no node with the legacy id. The LMS tables sit behind the third RLS wall, hence `modules: ["lms"]`.
import { isDeepStrictEqual } from "node:util";
import { withGlobal, withTenants, closePool } from "../db";
import { applyOrgStructure, sanitizeStructure, type OrgStructure } from "../admin/org-structure.service";
import {
  ensureFunctionalDepartments, legacyFunctionalNodeId, resolveFunctionalNodeId, startingOrgStructure,
} from "../admin/functional-departments";

/** Functional departments the LMS seeds put courses and paths on (lms-hr-it-curriculum.ts). */
const LMS_SLUGS = ["hr", "it"] as const;

export interface FunctionalDepartmentsReport {
  companyId: string;
  name: string;
  hadTree: boolean;
  existingDepartments: string[];
  /** What would be appended (always computed; empty for a refused company). */
  wouldAdd: string[];
  /** What was appended: `wouldAdd` when `written`, else empty. */
  added: string[];
  conflicts: { id: string; reason: string }[];
  written: boolean;
  /** LMS courses/paths moved from the legacy `d-hr` / `d-it` unit ids to this company's own node ids
   *  (counted on a dry run, moved on --apply). */
  lmsRepointed: { courses: number; paths: number };
}

/** Sanitize-stable means `sanitizeStructure(raw)` is the raw tree, apart from the `assigneeId` /
 *  `assigneeName` a seed left out (the sanitizer reads those as null, which changes nothing a reader
 *  sees). Returns a description of the first kind of difference, or null when stable. */
export function sanitizeDrift(raw: unknown): string | null {
  const obj = (raw ?? {}) as { root?: unknown };
  if (!obj.root || typeof obj.root !== "object") return "stored blob has no root node";
  type Raw = { id?: unknown; name?: unknown; kind?: unknown; assigneeId?: unknown; assigneeName?: unknown; children?: unknown };
  // The raw tree as sanitize would read it, WITHOUT coercing id/name/kind/children, so any coercion
  // shows up as a difference. Only the missing-assignee default is applied.
  const project = (n: Raw): unknown => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    assigneeId: typeof n.assigneeId === "string" ? n.assigneeId : null,
    assigneeName: typeof n.assigneeName === "string" ? n.assigneeName : null,
    children: Array.isArray(n.children) ? (n.children as Raw[]).map(project) : [],
  });
  const clean = sanitizeStructure(raw).root;
  return isDeepStrictEqual(project(obj.root as Raw), clean)
    ? null
    : "stored tree differs from its sanitized form (duplicate ids, unknown kinds, untrimmed names or size/depth limits)";
}

const NO_LMS = { courses: 0, paths: 0 };

export async function backfillFunctionalDepartments(opts: { apply: boolean }): Promise<FunctionalDepartmentsReport[]> {
  const companies = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name, id`),
  );
  const reports: FunctionalDepartmentsReport[] = [];
  for (const co of companies.rows) {
    reports.push(
      await withTenants(
        [co.id],
        async (c): Promise<FunctionalDepartmentsReport> => {
          // Lock the row so a concurrent org-builder PUT cannot interleave with read-modify-write.
          await c.query(`SELECT 1 FROM company_org_structure WHERE tenant_id = $1 FOR UPDATE`, [co.id]);
          const stored = await c.query<{ structure: unknown }>(
            `SELECT structure FROM company_org_structure WHERE tenant_id = $1`,
            [co.id],
          );
          const hadTree = stored.rows.length > 0;
          const refused = (
            existingDepartments: string[], conflicts: { id: string; reason: string }[],
          ): FunctionalDepartmentsReport => ({
            companyId: co.id, name: co.name, hadTree, existingDepartments,
            wouldAdd: [], added: [], conflicts, written: false, lmsRepointed: NO_LMS,
          });

          let source: OrgStructure;
          if (hadTree) {
            const drift = sanitizeDrift(stored.rows[0].structure);
            if (drift) return refused([], [{ id: "(tree)", reason: drift }]);
            source = stored.rows[0].structure as OrgStructure;
          } else {
            source = startingOrgStructure(co.name, co.id);
          }

          const r = ensureFunctionalDepartments(source, co.id);
          const existingDepartments = r.existing.map((d) => d.name);
          if (r.conflicts.length) return refused(existingDepartments, r.conflicts);
          if (hadTree && r.added.length > 0 && sanitizeDrift(r.structure)) {
            return refused(existingDepartments, [
              { id: "(tree)", reason: "adding the departments would exceed the org-tree size or depth limit" },
            ]);
          }
          // A starting tree already holds the three, so `added` is empty there: a missing tree is
          // written because it is missing, not because something was appended to it.
          const wouldWrite = r.added.length > 0 || !hadTree;
          const wouldAdd = hadTree ? r.added : r.structure.root.children.map((n) => n.id);
          const written = opts.apply && wouldWrite;
          if (written) await applyOrgStructure(c, co.id, r.structure);

          // LMS re-point, against the tree as it stands after this run.
          const lmsRepointed = { courses: 0, paths: 0 };
          const present = new Set<string>();
          const collect = (n: { id: string; children?: unknown[] }): void => {
            present.add(n.id);
            for (const ch of (n.children ?? []) as { id: string; children?: unknown[] }[]) collect(ch);
          };
          collect(r.structure.root);
          for (const slug of LMS_SLUGS) {
            const legacy = legacyFunctionalNodeId(slug);
            const target = resolveFunctionalNodeId(r.structure, slug, co.id);
            if (present.has(legacy) || !target) continue;
            for (const [table, key] of [["lms_courses", "courses"], ["lms_paths", "paths"]] as const) {
              const res = opts.apply
                ? await c.query(`UPDATE ${table} SET unit_node_id = $3, updated_at = now() WHERE tenant_id = $1 AND unit_node_id = $2`, [co.id, legacy, target])
                : await c.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND unit_node_id = $2`, [co.id, legacy]);
              lmsRepointed[key] += res.rowCount ?? 0;
            }
          }
          return {
            companyId: co.id, name: co.name, hadTree, existingDepartments, wouldAdd,
            added: written ? wouldAdd : [], conflicts: [], written, lmsRepointed,
          };
        },
        { modules: ["lms"] },
      ),
    );
  }
  return reports;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const reports = await backfillFunctionalDepartments({ apply });
  for (const r of reports) {
    const adds = r.wouldAdd.length ? `${apply ? "added" : "would add"} ${r.wouldAdd.join(", ")}` : "nothing to add";
    const conflicts = r.conflicts.length ? ` | CONFLICT: ${r.conflicts.map((x) => `${x.id}: ${x.reason}`).join("; ")}` : "";
    const lms = r.lmsRepointed.courses + r.lmsRepointed.paths
      ? ` | LMS ${apply ? "re-pointed" : "to re-point"}: ${r.lmsRepointed.courses} courses, ${r.lmsRepointed.paths} paths`
      : "";
    console.log(
      `${r.name} | tree: ${r.hadTree ? "yes" : "none"} | departments: ${r.existingDepartments.join(", ") || "(none)"} | ${adds}${lms}${conflicts}`,
    );
  }
  const conflicted = reports.filter((r) => r.conflicts.length).length;
  const changing = reports.filter((r) => r.wouldAdd.length || r.lmsRepointed.courses || r.lmsRepointed.paths).length;
  console.log(
    `\n${apply ? "APPLIED" : "DRY RUN (use --apply to write)"}: ${reports.length} companies, ` +
      `${changing} ${apply ? "changed" : "to change"}, ${conflicted} with conflicts.`,
  );
  await closePool();
  if (conflicted) process.exitCode = 1;
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
