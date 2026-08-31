// webdesk/blocks/src/renderer/report.ts
//
// WSK-16 — the second half of the renderer invariant (webdesk-design.md §05 hard rule 2): an
// unknown block type "renders nothing AND REPORTS" — "a console warning plus a reporting hook a
// host can wire to QA" (WSK-16 ticket text, verbatim). This file is that hook's shape and default.
export interface UnknownBlockReport {
  /** The raw, unrecognized block type string. */
  type: string
  /** Position in the envelope's `blocks` array (0-based). */
  index: number
  /** The envelope's `collection` key, when the renderer was given one (ItemRenderer always passes it). */
  collection?: string
  /** The envelope's `slug`, when the renderer was given one. */
  slug?: string
}

export type UnknownBlockReportHook = (report: UnknownBlockReport) => void

/**
 * The default reporting channel: a `console.warn`. Always fires unless a host supplies its own
 * `onUnknownBlock` (BlockRenderer.astro / ItemRenderer.astro `Props.onUnknownBlock`) — and even
 * then, a host is free to call this alongside its own QA hook rather than replacing it, since it
 * is exported for exactly that composition.
 */
export const defaultUnknownBlockReport: UnknownBlockReportHook = (report) => {
  const where = report.collection ? ` in "${report.collection}/${report.slug ?? '?'}"` : ''
  // eslint-disable-next-line no-console -- this IS the console-warning channel the invariant requires.
  console.warn(
    `[@gaiada/webdesk-blocks] unknown block type "${report.type}" at blocks[${report.index}]${where} — ` +
      'rendered nothing. This is the renderer invariant (webdesk-design.md §05 hard rule 2): a ' +
      'vocabulary-MINOR addition must reach a site pinned to an older renderer as a visible gap, ' +
      'never a crash.',
    report,
  )
}
