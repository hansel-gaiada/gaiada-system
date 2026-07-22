import { REASON_LABEL, type EnvelopeCompany } from "@/lib/envelope";
import "./scope.css";

// Renders nothing when every company is included (UX-2 §4.3) — never a
// fixed-height banner eating space on the common case. Otherwise: "Showing N
// of M companies — K excluded (reasons). [why?]" with the excluded list
// behind a native <details> disclosure (no client JS needed).
export function EnvelopeBanner({ companies }: { companies: EnvelopeCompany[] }) {
  const excluded = companies.filter((c) => !c.included);
  if (excluded.length === 0) return null;
  const included = companies.length - excluded.length;
  return (
    <p className="sys-empty-note scope-envelope" role="status">
      Showing {included} of {companies.length} companies — {excluded.length} you can&apos;t view.{" "}
      <details className="scope-envelope__why">
        <summary>why?</summary>
        <ul className="scope-envelope__list">
          {excluded.map((c) => (
            <li key={c.id}>
              {c.name}: {REASON_LABEL[c.reason ?? "error"]}
            </li>
          ))}
        </ul>
      </details>
    </p>
  );
}
