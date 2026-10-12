// PV3-09 — "who sees this row", on every row of the staff client hub that has an answer.
//
// ── THE ONLY INPUT IS THE BACKEND'S `clientVisible` ─────────────────────────────────────────────
// `true` renders "Client sees this", `false` renders "Internal", and ANYTHING ELSE renders nothing. The
// third case matters most. A row whose payload carries no `clientVisible` (an older server, a detail read
// the backend did not extend, a row kind PV3-07 does not cover) must NOT be given either answer:
//   - defaulting to "Internal" would tell staff a row is private when the client may be reading it;
//   - defaulting to "Client sees this" is the leak direction: staff would type something sensitive into a
//     row they believe the client can already see, or, worse, believe a private row is public and stop caring.
// Saying nothing is the only answer that claims nothing. The comparison is strict (`=== true` / `=== false`)
// so `null`, `"true"`, `1` and `undefined` all say nothing too.
//
// The flag is computed in SQL from the portal's own predicates (BFF §22d); this component never derives it
// from a status, a kind or a name. Its exact meaning is "a client-wide contact of this row's client can read
// it in the portal": a project-scoped contact may see less, so the label says what the client MAY see, and
// the tooltip-free text avoids promising more than that.
//
// ── NOT COLOUR ALONE ────────────────────────────────────────────────────────────────────────────
// Every state carries its words, and the two states also differ in shape (a solid edge for the client's,
// a dashed one for Internal, the same grammar as the Internal tab). Text is always `--ink-strong`; the
// family colour lives in the tint and the edge, which is what keeps contrast at AA in both themes (the
// lesson of the Internal tab, clientHub.css).

export type Visibility = "client" | "internal";

/** The one place the three-way decision is made. Exported so the rule is tested directly. */
export function visibilityOf(clientVisible: unknown): Visibility | null {
  if (clientVisible === true) return "client";
  if (clientVisible === false) return "internal";
  return null;
}

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  client: "Client sees this",
  internal: "Internal",
};

export function ClientVisibilityMarker({ clientVisible }: { clientVisible?: boolean | null }) {
  const v = visibilityOf(clientVisible);
  if (v === null) return null;
  return (
    <span className={`ch-vis ch-vis--${v}`} data-visibility={v}>
      {VISIBILITY_LABEL[v]}
    </span>
  );
}
