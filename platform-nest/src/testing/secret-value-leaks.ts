// M6-P6o — the leak scanner for a deploy credential's VALUE (test-only helper), in the style of PGL-10's
// invite-token-leaks.ts.
//
// The question it answers: does ANY stored row, outbox event, log line, HTTP response or recorded outbound call hold a
// secret value the test planted? It looks for every needle in the forms a value takes when it travels: raw, JSON-escaped
// (inside a jsonb column or a JSON body), base64 (a sealed or encoded copy), and URL-encoded. A needle shorter than 8
// characters is refused: a short needle matches by accident and a scan that "finds" noise is as useless as one that
// finds nothing. Use canary values minted per run (random hex), never anything that looks like a real credential: the
// repository is public.

export interface ScannedBlob {
  where: string;
  text: string;
}

function forms(needle: string): string[] {
  const out = new Set<string>([needle, JSON.stringify(needle).slice(1, -1), Buffer.from(needle, "utf8").toString("base64"), encodeURIComponent(needle)]);
  // base64 of a value embedded at another offset shifts the alphabet; the value's middle third survives any alignment.
  const b64 = Buffer.from(needle, "utf8").toString("base64");
  if (b64.length >= 24) out.add(b64.slice(4, b64.length - 4));
  return [...out];
}

/** Every finding as `"<where>: <which needle> (<form>)"`. Empty means clean. */
export function findSecretValueLeaks(blobs: readonly ScannedBlob[], needles: Record<string, string>): string[] {
  const findings: string[] = [];
  for (const [label, needle] of Object.entries(needles)) {
    if (typeof needle !== "string" || needle.length < 8) throw new Error(`needle ${label} is shorter than 8 characters: it would match by accident`);
    const fs = forms(needle);
    for (const { where, text } of blobs) {
      for (const f of fs) {
        if (text.includes(f)) {
          findings.push(`${where}: ${label} (${f === needle ? "raw" : "encoded"})`);
          break;
        }
      }
    }
  }
  return findings;
}
