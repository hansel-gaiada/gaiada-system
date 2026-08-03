// Shared text chunker for both knowledge ingestion tiers (public web + internal ERP).
//
// The WS8 store embeds ONE VECTOR PER CHUNK, so chunk size is the retrieval-quality knob: too big
// and a chunk's embedding averages several unrelated topics into a vector that matches nothing
// sharply; too small and a hit loses the context needed to answer from it. ~1200 characters with a
// ~150-character overlap is the usual middle ground for prose, and the overlap specifically stops a
// fact that straddles a boundary ("...the retainer is" | "IDR 45m/month...") from becoming
// unretrievable in both neighbours.
//
// Splitting prefers PARAGRAPH boundaries, then sentence boundaries, and only hard-cuts mid-sentence
// when a single sentence exceeds the budget — so chunks stay semantically whole wherever the source
// gives us a seam to use.

export interface ChunkOpts {
  /** Target maximum characters per chunk. */
  maxChars?: number;
  /** Characters of tail context repeated at the head of the next chunk. */
  overlap?: number;
}

const DEFAULT_MAX = 1200;
const DEFAULT_OVERLAP = 150;
/** Below this a "chunk" is noise (a stray heading, a nav crumb) and costs an embedding call. */
const MIN_CHUNK_CHARS = 40;

/** Collapse the whitespace zoo that HTML-to-text and DB text fields produce into single spaces /
 *  single blank lines, so chunk budgets measure CONTENT and not indentation. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split on paragraph breaks, then sentence ends, keeping the delimiter with the left piece. */
function segments(text: string): string[] {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const out: string[] = [];
  for (const p of paras) {
    if (p.length <= DEFAULT_MAX) {
      out.push(p);
      continue;
    }
    // Sentence-ish split: terminator + whitespace. Deliberately simple — an over-eager split here
    // only costs a slightly smaller chunk, never a lost character.
    out.push(...p.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0));
  }
  return out;
}

/** Chunk `input` into embeddable pieces. Returns [] for empty/whitespace-only input, so a caller
 *  can use the empty array as "nothing worth ingesting" without a separate check. */
export function chunkText(input: string, opts: ChunkOpts = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX;
  const overlap = Math.min(opts.overlap ?? DEFAULT_OVERLAP, Math.floor(maxChars / 2));
  const text = normalizeText(input);
  if (!text) return [];

  const chunks: string[] = [];
  let current = "";

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) chunks.push(trimmed);
    else if (trimmed.length > 0 && chunks.length > 0) {
      // Too small to stand alone: fold the remainder back into the previous chunk rather than
      // emitting a fragment that can only ever be a weak, contextless hit.
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n${trimmed}`;
    } else if (trimmed.length > 0) {
      chunks.push(trimmed); // the ONLY content there is — a one-line source is still a source
    }
    current = "";
  };

  for (const seg of segments(text)) {
    if (seg.length > maxChars) {
      // A single unsplittable run (minified text, a giant table row). Hard-cut it with overlap.
      flush();
      for (let i = 0; i < seg.length; i += maxChars - overlap) {
        chunks.push(seg.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if (current && current.length + seg.length + 1 > maxChars) {
      const tail = current.slice(-overlap);
      flush();
      // Carry the tail forward so a boundary-straddling fact survives in the next chunk too.
      current = overlap > 0 ? `${tail.trimStart()}\n${seg}` : seg;
      continue;
    }
    current = current ? `${current}\n${seg}` : seg;
  }
  flush();
  return chunks;
}

/** Render a labelled field block ("Status: active") skipping empty values, then chunk it. Used by
 *  the ERP ingester so every record becomes self-describing prose — an embedding of a bare value
 *  like "blocked" is meaningless, but "Status: blocked" next to the project name is retrievable. */
export function renderFields(fields: Array<[string, unknown]>): string {
  return fields
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
    .join("\n");
}
