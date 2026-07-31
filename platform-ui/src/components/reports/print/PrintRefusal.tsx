// TR-20 — the print route's honest refusal state. §6.3: "the print route renders nothing without a
// valid one-shot token" — a missing/invalid/expired/already-burned jobToken, or an unreachable/
// malformed upstream, must produce THIS, never a partial document and never a crash. Deliberately
// generic (no jobToken, no reason code, no upstream detail) — this page's only audience is whatever
// ends up looking at the render (the sidecar always turns it into a PDF; a human could also hit this
// URL directly), and a one-shot-token failure is not a place to leak which of several reasons applied.
export function PrintRefusal() {
  return (
    <div className="tr20-refusal" role="alert">
      <h1 className="tr20-refusal__title">This report link can&rsquo;t be rendered</h1>
      <p className="tr20-refusal__body">
        The link is missing, invalid, expired, or has already been used. Report links are single-use
        and time-limited — generate a new export to get a fresh one.
      </p>
    </div>
  );
}
