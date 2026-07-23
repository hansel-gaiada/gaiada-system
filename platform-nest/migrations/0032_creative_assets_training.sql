-- Creative assets — training curation flag. The phase-2 AI (creative-grading-trainer) learns
-- the house look from persisted (original → graded) pairs, but a pair only helps if it is a
-- clean, on-brand exemplar (tone/colour edit, not a crop/retouch/throwaway). This flag lets the
-- creative team CURATE at the source: mark which saved assets are good exemplars, and the
-- trainer's prepare_from_erp pulls only those (?trainingReady=true). Default true — every save
-- is a candidate until someone excludes it — which keeps the flywheel turning while still
-- allowing curation. Append-only migration (never edit a shipped one).
ALTER TABLE creative_assets ADD COLUMN training_ready boolean NOT NULL DEFAULT true;
CREATE INDEX ix_creative_assets_training ON creative_assets (tenant_id, training_ready) WHERE deleted_at IS NULL;
