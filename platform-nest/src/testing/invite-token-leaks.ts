// PGL-10 — the structural leak scanner for client invite tokens (test-only helper).
//
// The question it answers: does ANY stored or logged text contain a string that sha256-hashes to an invite token the
// database knows? It does not need to know the tokens: it extracts every token-SHAPED substring (`inv<digit>.` and its
// dot-separated segments), hashes every dot-boundary prefix of it, and looks the hash up in the set of stored
// `client_invites.token_hash` values. A second, direct check also looks for every raw token the test itself saw (for
// example in a captured outgoing mail), which catches a leaked token whose hash has since been rotated away.
import { createHash } from "node:crypto";

export interface ScannedBlob {
  where: string;
  text: string;
}

const TOKEN_SHAPE = /inv\d(?:\.[A-Za-z0-9_-]+)+/g;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Every finding as `"<where>: <reason>"`. Empty means clean. */
export function findInviteTokenLeaks(blobs: ScannedBlob[], storedHashes: ReadonlySet<string>, knownTokens: readonly string[] = []): string[] {
  const findings: string[] = [];
  for (const { where, text } of blobs) {
    for (const m of text.matchAll(TOKEN_SHAPE)) {
      const segs = m[0].split(".");
      // A token is 4 (v1) or 5 (v2) segments; a glued-on suffix adds more, so test every dot-boundary prefix.
      for (let n = 2; n <= segs.length; n += 1) {
        const candidate = segs.slice(0, n).join(".");
        if (storedHashes.has(sha256(candidate))) findings.push(`${where}: a string hashing to a stored invite token`);
      }
    }
    for (const t of knownTokens) {
      if (t && text.includes(t)) findings.push(`${where}: a raw invite token seen by the test`);
    }
  }
  return findings;
}
