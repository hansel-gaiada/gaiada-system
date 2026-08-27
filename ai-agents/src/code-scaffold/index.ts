// WSK-20 — public surface of the code.scaffold v2 goal. A future runner-service integration (wiring
// `agent === "code-scaffold-v2"` into ai-agents/src/runner/service.ts's dispatch) imports from here;
// this ticket does not touch service.ts itself (see this ticket's own report: out of strict scope).
export type { ScaffoldJobEnvelope, ScaffoldConstraints, SiteKind, ScaffoldResult, ScaffoldOutcome, VocabularyGap, ContractLock } from "./envelope";
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
