// PV5-07 — the document print routes' refusal: a missing, invalid, expired or already-used token, or an unreachable
// upstream. Generic on purpose (no token, no reason). It never carries the render nonce, so platform-nest refuses to
// store a PDF of this page (core/document-render.ts).
export function DocumentRefusal() {
  return (
    <div className="doc-print doc-print__refusal" role="alert">
      <h1 className="doc-print__title">This document link can&rsquo;t be rendered</h1>
      <p>The link is missing, invalid, expired or has already been used. Document links are single-use and time-limited.</p>
    </div>
  );
}
