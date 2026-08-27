// WSK-20 — §06 verbatim: "CONTRACT.lock at repo root: {snapshotId, contractVersion,
// vocabularyVersion, contentHash, blockLibraryVersion}". Field set and order are load-bearing (a
// future consumer diffs this file directly) — do not add/reorder/rename fields here without an
// architect-approved amendment to §06.
import type { ContractLock } from "./envelope";

export function buildContractLock(args: {
  snapshotId: string;
  contractVersion: string;
  vocabularyVersion: string;
  contentHash: string;
  blockLibraryVersion: string;
}): ContractLock {
  return {
    snapshotId: args.snapshotId,
    contractVersion: args.contractVersion,
    vocabularyVersion: args.vocabularyVersion,
    contentHash: args.contentHash,
    blockLibraryVersion: args.blockLibraryVersion,
  };
}

export function contractLockFileContent(lock: ContractLock): string {
  // Sorted-key canonical form, same idiom as the mirror's own contentHash discipline
  // (contract-snapshot.service.ts's computeContentHash: `JSON.stringify(obj, sortedKeyArray)`, which
  // both FILTERS and ORDERS the emitted keys) — a CONTRACT.lock diff should never show a spurious
  // key-order churn between two scaffolds of the same pin.
  return JSON.stringify(lock, Object.keys(lock).sort(), 2) + "\n";
}
