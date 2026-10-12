// WSK-20 — public surface of the code.scaffold v2 goal. M6-P4b1 wired it into the runner: a goal whose
// `agent` is "code-scaffold-v2" (CODE_SCAFFOLD_AGENT) is dispatched by ai-agents/src/runner/service.ts to
// `runScaffoldJob` (runner-job.ts), dry run only.
export { CODE_SCAFFOLD_AGENT, SCAFFOLD_GOAL_MAX_CHARS, runScaffoldJob, parseScaffoldGoal, scaffoldDedupeKey, type ScaffoldJobResult, type ScaffoldGoalPayload } from "./runner-job";
export type { ScaffoldJobEnvelope, ScaffoldConstraints, SiteKind, ScaffoldResult, ScaffoldFileEntry, ScaffoldOutcome, VocabularyGap, ContractLock } from "./envelope";
export { runCodeScaffold, type ScaffoldDeps } from "./scaffold";
export type { PushTarget } from "./git-writer";
export {
  HubContractSnapshotProvider,
  FakeContractSnapshotProvider,
  SnapshotNotFoundError,
  type ContractSnapshotProvider,
  type ContractSnapshotArtifacts,
  type ContractSnapshotMeta,
} from "./contract-snapshot-provider";
export { HubArtifactFetcher, FakeArtifactFetcher, type ArtifactFetcher } from "./artifact-fetcher";
