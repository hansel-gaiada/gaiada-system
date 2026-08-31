// WSK-20 — `code.scaffold` v2, the rail's demand end.
// Design: docs/blueprints/webdesk-design.md §06 ("The scaffold job envelope — FROZEN") + §06's
// "The scaffolder" subsection (what it generates) + WSK-D6 (never install/exec).
//
// ── THE FROZEN ENVELOPE — DO NOT MODIFY THIS SHAPE ──────────────────────────────────────────────
// Reproduced verbatim from §06's fenced jsonc block (the mirror webdev-design.md §05 froze first).
// Both ends of the rail (Zone B's control-plane job dispatch and this consumer) build to this exact
// shape; changing a field here silently breaks the other end with no compiler to catch it, since the
// two live in separate repos/processes. If a real field is missing, that is a spec gap to REPORT, not
// a reason to add one here.
export type SiteKind = "astro" | "node" | "wp";

export interface ScaffoldConstraints {
  /** "from the snapshot" — the pinned @gaiada/webdesk-blocks version this run must install. */
  blockLibraryVersion: string;
  maxRevise: number;
}

/** hub tool `code.scaffold` — async job (agent-runner goal), impact: medium write (repo push). */
export interface ScaffoldJobEnvelope {
  /** pipeline run (stage claude_code) */
  runId: string;
  /** PM-created (github.repoStatus gates, unchanged) */
  repoUrl: string;
  siteKind: SiteKind;
  /** pipeline_stages.artifact_ref of the SIGNED prd stage */
  prdArtifact: string;
  /** artifact_ref of the accepted design stage */
  prototypeArtifact: string;
  /** webdev_contract_snapshots.id — THE pin */
  contractSnapshotId: string;
  constraints: ScaffoldConstraints;
}

// ── Everything below is THIS ticket's own vocabulary, not part of the frozen envelope. ──────────

/** A vocabulary/composition gap the prototype referenced that the pinned contract snapshot cannot
 *  satisfy (design §06: "a vocabulary gap becomes a flagged TODO plus a proposeSchema draft — never
 *  hand-rolled fetch code"). One per unresolved page/collection/block reference. */
export interface VocabularyGap {
  pageSlug: string;
  kind: "unknown-collection" | "unknown-block-type";
  reference: string;
  /** Relative path (within the generated repo) of the TODO stub page this gap produced. */
  todoFilePath: string;
  /** Relative path of the generated schema-proposal draft (WSK-32's webdesk.schema.propose shape). */
  proposalFilePath: string;
}

export type ScaffoldOutcome =
  | "pushed"
  | "dry_run"
  | "rejected_site_kind"
  | "snapshot_fetch_failed"
  | "artifact_fetch_failed";

/** `design.prototype`-style job/result shape, preserved (webdev D-10, PROGRESS.md WSK-20 row): a flat,
 *  serializable `{content}`-shaped result the hub tool's synchronous handlers already return, widened
 *  here to what an async repo-push job actually needs to report. `content` stays the human-readable
 *  summary a chat/automation caller renders directly, mirroring `code.scaffold` v1
 *  (mcp-hub/src/delivery-tools.ts) and `design.prototype`'s own `JSON.stringify({ content })` return. */
export interface ScaffoldResult {
  outcome: ScaffoldOutcome;
  content: string;
  /** Present only when outcome is "pushed" or "dry_run". */
  files?: string[];
  gaps?: VocabularyGap[];
  contractLock?: ContractLock;
  /** The ref actually pushed (branch/sha), or the local bare-repo path in dry-run mode. */
  pushedTo?: string;
  error?: string;
}

/** §06: "CONTRACT.lock at repo root: {snapshotId, contractVersion, vocabularyVersion, contentHash,
 *  blockLibraryVersion}" — verbatim field set, this ticket's own contract with itself. */
export interface ContractLock {
  snapshotId: string;
  contractVersion: string;
  vocabularyVersion: string;
  contentHash: string;
  blockLibraryVersion: string;
}
