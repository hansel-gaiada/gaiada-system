-- 202609011230_webdev_provisioned_sites_framework_widen.sql
--
-- Owner ruling, docs/blueprints/webdesk-design-v2.md §08 ("One kind vocabulary, mapped everywhere",
-- WSK-D28): WordPress and full-stack sites are no longer refused-by-design. `0090`'s
-- `framework CHECK IN ('vite','nextjs')` was one of the FOUR places that refusal was encoded
-- (design D-P7, "v1 provider vocabulary only... WordPress/full-stack are refused-with-routing
-- before a row is ever written, never downgraded"). §08 requires all four to move in the SAME
-- change or the console and the scaffolder disagree silently about what a stored value means —
-- this migration is the schema quarter of that change; the other three are the
-- `webdev.provisionSite` MCP tool's `framework` enum, its `stack` hint (refusal -> selector), and
-- `ai-agents/src/code-scaffold/scaffold.ts`'s `rejected_site_kind` branch (all edited in this same
-- commit, see PR description / ticket report for file:line).
--
-- ── WHAT "WIDEN" MEANS HERE, PRECISELY ────────────────────────────────────────────────────────
-- §08's kind table maps the THREE canonical kinds (`static`/`wp`/`fullstack`) onto framework
-- values that are a superset of the two provision already understood:
--   static    -> `astro` (works today as `vite`; `astro` is the canonical alias)
--   fullstack -> `node`  (works today as `nextjs`; `node` is the canonical alias)
--   wp        -> `wp`    (new: provision cannot deliver this — see provision-http.ts's
--                          capability-boundary rejection, added in the same commit — but the ROW
--                          must still be insertable, because a `requested` row is written before
--                          egress even runs, and a provider-rejected attempt still needs to be
--                          recorded as `failed/provider_rejected`, not blocked by the CHECK itself)
-- `vite`/`nextjs` are KEPT (not renamed/dropped) — every already-applied row used one of those two
-- values, and rule 4 (migrations/README.md) forbids rewriting history; this is a purely ADDITIVE
-- widen, so no existing row can violate the new, larger set.
--
-- ── WHY DROP-AND-RE-ADD, LOOKED UP BY DEFINITION ──────────────────────────────────────────────
-- Postgres cannot ALTER a CHECK in place. Copies 0028's / 0115's own verbatim idiom: find the
-- constraint by its DEFINITION (`%framework%`), not by a hardcoded name, because 0090 let Postgres
-- auto-name it and a literal guess would break silently on any environment where that name differs.
--
-- ── ZERO BACKFILL DML ──────────────────────────────────────────────────────────────────────────
-- No UPDATE/DELETE/INSERT..SELECT anywhere in this file. Every existing row's `framework` value
-- (`vite`/`nextjs`) is already a member of the widened set, so there is nothing to backfill.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'webdev_provisioned_sites'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%framework%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE webdev_provisioned_sites DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE webdev_provisioned_sites
  ADD CONSTRAINT webdev_provisioned_sites_framework_check
  CHECK (framework IN ('vite', 'nextjs', 'astro', 'node', 'wp'));
