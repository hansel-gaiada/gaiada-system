-- P2-03 — Custom fields on tasks (pm-console-ux-design-spec.md §5, §8; D17 framework reuse).
-- Additive, backward-compatible: one new column with a default, no existing data touched.
-- entity_type "pm_task" is validated against the tenant's existing custom_field_definitions
-- registry (core/custom-fields.ts) exactly like "project"/"client"/"agency_campaign" already are —
-- no schema change needed there, the registry is entity-type-agnostic.
ALTER TABLE pm_tasks ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';
