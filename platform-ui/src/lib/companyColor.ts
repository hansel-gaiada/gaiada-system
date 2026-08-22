// Deterministic company id -> categorical tone (design-language spec §7, "Multi-company identity
// colour"). Pure, no I/O, client-safe: consumed by the sidebar's company spine (a client component)
// and, per §7.4, is available to any future cross-company row/card rail without a lookup table.
//
// "Deterministic hash of company id -> --cat-1..8": a simple string hash mod 8 rather than anything
// cryptographic — stability across sessions (same id always resolves to the same tone) is the whole
// requirement, not collision-resistance. §7's own "degradation beyond 8 companies is accepted, not
// solved" note applies here too: hue reuse at company #9+ is a half-second slower scan, not a wrong
// reading, because the company name always sits next to the tone (never the sole conveyor).
const TONE_COUNT = 8;

/** 1-8, stable for a given id. */
export function companyToneIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % TONE_COUNT) + 1;
}

/** The `--cat-N` custom property name for a company id, ready for a `var()` reference. */
export function companyToneVar(id: string): string {
  return `var(--cat-${companyToneIndex(id)})`;
}

/** The `--cat-N-line` hairline companion, for borders/rails that need a softer edge. */
export function companyToneLineVar(id: string): string {
  return `var(--cat-${companyToneIndex(id)}-line)`;
}
