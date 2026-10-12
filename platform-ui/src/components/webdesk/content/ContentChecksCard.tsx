"use client";
import { useState } from "react";
import type { ContentFinding, Lint } from "@/lib/webdeskContentModel";

/** Find the editor field for a finding's JSON-pointer-ish `path`: the exact `data-pointer`, else the nearest ancestor. */
export function locateField(path: string, root: ParentNode = document): HTMLElement | null {
  if (!path.startsWith("/") || path === "/") return null;
  const segs = path.split("/").slice(1);
  for (let n = segs.length; n > 0; n--) {
    const p = "/" + segs.slice(0, n).join("/");
    const el = Array.from(root.querySelectorAll<HTMLElement>("[data-pointer]")).find((e) => e.getAttribute("data-pointer") === p);
    if (el) return el;
  }
  return null;
}

/** The advisory "Content checks" card (M5-W3b). Advisory only: it never blocks saving or publishing. An empty list is a
 *  claim, so "no issues" is shown only when the checks reported and none of them failed to run. */
export function ContentChecksCard({ lint }: { lint: Lint }) {
  const [missed, setMissed] = useState<string | null>(null);
  const c = lint.content;

  const go = (path: string) => {
    const el = locateField(path);
    if (!el) { setMissed(path); return; }
    setMissed(null);
    el.scrollIntoView?.({ block: "center" });
    el.focus?.();
  };

  let body: React.ReactNode;
  if (lint.unavailable !== undefined || c === undefined) {
    body = (
      <p className="wc-publish__sub" role="note" data-testid="content-checks-absent">
        {lint.unavailable !== undefined
          ? "Couldn't run the content checks. This is not a statement that there are no issues."
          : "This WebDesk did not report content checks, so nothing was checked. This is not a statement that there are no issues."}
      </p>
    );
  } else {
    const allUnavailable = c.unavailable.length > 0 && c.findings.length === 0 && c.aeo === null;
    const groups: Array<[string, ContentFinding[]]> = [
      ["Needs attention", c.findings.filter((f) => f.severity === "warn")],
      ["Suggestions", c.findings.filter((f) => f.severity === "info")],
    ];
    body = (
      <>
        <p className="wc-publish__sub">Advisory only — these never block saving or publishing.</p>
        {allUnavailable ? (
          <p className="wc-publish__sub" role="note" data-testid="content-checks-none-ran">
            None of the content checks could run. This is not a statement that there are no issues.
          </p>
        ) : c.findings.length === 0 ? (
          <p className="wc-publish__sub" data-testid="content-checks-clean">
            {c.unavailable.length > 0 ? "No issues from the checks that could run." : "No content issues found."}
          </p>
        ) : (
          groups.filter(([, fs]) => fs.length > 0).map(([label, fs]) => (
            <div key={label} data-testid={`content-findings-${label === "Needs attention" ? "warn" : "info"}`}>
              <h4>{label} ({fs.length})</h4>
              <ul className="wc-lint">
                {fs.map((f, i) => (
                  <li key={`${f.code}-${f.path}-${i}`} data-code={f.code}>
                    {f.message}{" "}
                    {f.path !== "/" && (
                      <button type="button" className="wc-linkbtn" onClick={() => go(f.path)} data-testid="finding-goto" aria-label={`Go to the field for: ${f.message}`}>
                        <code>{f.path}</code>
                      </button>
                    )}
                    {missed === f.path && <span className="wc-publish__sub" role="status"> (no single field to jump to)</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        {c.aeo === null ? (
          !allUnavailable && <p className="wc-publish__sub" data-testid="aeo-none">No AEO score: this item has no long-form body to score.</p>
        ) : (
          <div data-testid="aeo">
            <h4>AEO score: <span data-testid="aeo-score">{c.aeo.score}</span>/100</h4>
            <table className="wc-aeo">
              <thead><tr><th scope="col">Factor</th><th scope="col">Points</th><th scope="col">Detail</th></tr></thead>
              <tbody>
                {c.aeo.factors.map((f) => (
                  <tr key={f.id} data-testid={`aeo-factor-${f.id}`}><td>{f.label}</td><td>{f.points}/{f.max}</td><td>{f.detail}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="wc-publish__sub">A structural heuristic for answer-engine readiness, not a ranking prediction.</p>
          </div>
        )}
        {c.unavailable.length > 0 && (
          <ul className="wc-lint" data-testid="content-unavailable">
            {c.unavailable.map((u) => <li key={u.rule}>couldn&apos;t check: {u.rule}{u.reason ? ` (${u.reason})` : ""}</li>)}
          </ul>
        )}
      </>
    );
  }
  return (
    <section className="wc-side-card" data-testid="content-checks-card">
      <h3>Content checks</h3>
      {body}
    </section>
  );
}
