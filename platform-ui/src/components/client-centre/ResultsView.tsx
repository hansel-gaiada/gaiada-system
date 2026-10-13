import { cardsForSection, type BusinessResults, type RegistryArea, type RegistrySection } from "@/lib/clientCentre";
import { ServiceCard } from "./ServiceCard";

export const RESULTS_EMPTY_COPY = "We don't run a service in this area yet.";
export const RESULTS_UNAVAILABLE_COPY = "Some results could not be loaded. Try again later.";
export const RESULTS_HIDDEN_COPY = "Results are shared with your organisation's main contacts.";

// PV6-03 — the "Services & results" part of an area page. `results` is `null` when the read itself failed.
// States, in order: read failed → one notice; `visible: false` → one sentence, nothing else; otherwise the cards
// (Marketing rolls up its sub-areas', grouped by sub-area), plus one notice when any service failed to load.
// "We don't run a service here" is only ever said when nothing failed to load: an unavailable service is never
// shown as an empty area.
export function ResultsView({
  section,
  results,
  showClientMarker,
  websiteHref,
}: {
  section: RegistryArea | RegistrySection;
  results: BusinessResults | null;
  showClientMarker: boolean;
  websiteHref?: string | null;
}) {
  if (results === null) return <p className="cc-results-note" role="status">{RESULTS_UNAVAILABLE_COPY}</p>;
  if (!results.visible) return <p className="cc-results-note">{RESULTS_HIDDEN_COPY}</p>;

  const cards = cardsForSection(results, section);
  const subAreas = (section as RegistryArea).subAreas ?? [];
  const failed = results.unavailable.length > 0;

  const own = cards.filter((c) => c.areaId === section.id);
  const groups = subAreas
    .map((s) => ({ sub: s, cards: cards.filter((c) => c.areaId === s.id) }))
    .filter((g) => g.cards.length > 0);

  return (
    <div className="cc-results">
      {failed && <p className="cc-results-note" role="status">{RESULTS_UNAVAILABLE_COPY}</p>}
      {cards.length === 0 && !failed && <p className="cc-results-note">{RESULTS_EMPTY_COPY}</p>}
      {own.map((c) => (
        <ServiceCard key={`${c.service}-${c.areaId}`} card={c} showClientMarker={showClientMarker} websiteHref={websiteHref} />
      ))}
      {groups.map((g) => (
        <section key={g.sub.id} className="cc-results-group" aria-labelledby={`cc-rg-${g.sub.id}`}>
          <h3 id={`cc-rg-${g.sub.id}`} className="cc-sec-h">{g.sub.name}</h3>
          {g.cards.map((c) => (
            <ServiceCard key={`${c.service}-${c.areaId}`} card={c} showClientMarker={showClientMarker} websiteHref={websiteHref} headingLevel={4} />
          ))}
        </section>
      ))}
    </div>
  );
}
