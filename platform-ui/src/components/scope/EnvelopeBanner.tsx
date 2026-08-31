import { REASON_LABEL, type EnvelopeCompany } from "@/lib/envelope";
import "./scope.css";

// Renders nothing when every company is included (UX-2 §4.3) — never a
// fixed-height banner eating space on the common case. Otherwise: "Showing N
// of M companies — K excluded (reasons). [why?]" with the excluded list
// behind a native <details> disclosure (no client JS needed).
export function EnvelopeBanner({ companies }: { companies: EnvelopeCompany[] }) {
  const excluded = companies.filter((c) => !c.included);
  // AGN-3: a company can be INCLUDED and still incomplete — one of its sources was refused or
  // unreachable while the rest answered. That case rendered nothing at all, so the result looked
  // whole. On a work queue that is the dangerous direction: a short list reads as "this is all of
  // it" and an empty one reads as "you are done", and neither is safe to imply.
  const partial = companies.filter((c) => c.included && (c.partialSources?.length ?? 0) > 0);
  if (excluded.length === 0 && partial.length === 0) return null;
  const included = companies.length - excluded.length;
  // A <div>, NOT a <p> — and that is a correctness fix, not a style preference.
  //
  // This used to be a <p> wrapping the <details>/<summary>/<ul>/<li> disclosure below. `<p>` may only
  // contain PHRASING content, so the browser's parser closes it the moment it meets `<details>`,
  // reparents everything after it, and React then reports a hydration mismatch on every render of
  // this banner: "<details> cannot be a descendant of <p>", plus the inverse pairs once the DOM has
  // been silently restructured.
  //
  // ⚠ WHY IT SURVIVED SO LONG: this banner renders ONLY when a read actually failed
  // (`excluded.length || partial.length`), so DEMO_MODE — where every fixture answers — never rendered
  // it once. It was found against a real backend, as a member-tier principal whose reads are refused.
  // The honest-failure surfaces are exactly the ones fixtures exercise least.
  //
  // `.sys-empty-note` is class-scoped in systems.css (not `p.sys-empty-note`), so the styling is
  // byte-identical on a div, and `role="status"` is valid on either.
  return (
    <div className="sys-empty-note scope-envelope" role="status">
      {excluded.length > 0 ? (
        <>
          Showing {included} of {companies.length} companies — {excluded.length} you can&apos;t view.{" "}
        </>
      ) : null}
      {partial.length > 0 ? (
        <>
          <strong>This list is incomplete</strong> — {partial.length === 1 ? "one company" : `${partial.length} companies`}{" "}
          could not be read in full, so treat an empty or short result as unknown rather than settled.{" "}
        </>
      ) : null}
      <details className="scope-envelope__why">
        <summary>why?</summary>
        <ul className="scope-envelope__list">
          {excluded.map((c) => (
            <li key={c.id}>
              {c.name}: {REASON_LABEL[c.reason ?? "error"]}
            </li>
          ))}
          {partial.map((c) => (
            <li key={`partial-${c.id}`}>
              {c.name}: shown, but these could not be read — {c.partialSources!.join(", ")}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
