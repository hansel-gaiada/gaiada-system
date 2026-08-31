// AGN-3 residual, closed: a queue that is SHORT must say so.
//
// The banner already handled a company being fully EXCLUDED. The quieter case — included, but one of
// its six sources refused or unreachable — rendered nothing, so a partial result looked whole. On a
// "work waiting for you" surface that is the dangerous direction: a short list reads as "this is all
// of it", an empty one reads as "you are done", and neither is safe to imply from a failed read.
//
// UX-2 §1.5 requires that one dead source must not blank the queue, and that requirement is right.
// What was missing was the other half: surviving a dead source must not be indistinguishable from
// succeeding.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EnvelopeBanner } from "./EnvelopeBanner";
import { isUnderstated, type EnvelopeCompany } from "@/lib/envelope";

const co = (over: Partial<EnvelopeCompany>): EnvelopeCompany => ({
  id: over.id ?? "c1",
  name: over.name ?? "Acme",
  included: over.included ?? true,
  ...over,
});

describe("AGN-3 · EnvelopeBanner surfaces an incomplete result", () => {
  it("renders NOTHING when every company answered in full — the common case stays quiet", () => {
    // Load-bearing: a banner that always renders trains people to ignore it, which would make the
    // partial case below invisible for the usual reason rather than the technical one.
    const { container } = render(<EnvelopeBanner companies={[co({}), co({ id: "c2", name: "Beta" })]} />);
    expect(container.textContent).toBe("");
  });

  it("🔴 an INCLUDED company with a failed source is announced as incomplete", () => {
    render(<EnvelopeBanner companies={[co({ partialSources: ["pipeline gates"] })]} />);
    const text = document.body.textContent ?? "";
    expect(
      text,
      "a company was read only in part and the banner said nothing — the queue is short and the " +
        "viewer has no way to know, which is the exact 'you are done' failure this closes",
    ).toMatch(/incomplete/i);
    // The wording must push against the wrong inference, not merely report a fact.
    expect(text).toMatch(/unknown rather than settled/i);
  });

  it("names the sources that failed, because 'incomplete' alone is not actionable", () => {
    render(<EnvelopeBanner companies={[co({ partialSources: ["pipeline gates", "mentions"] })]} />);
    expect(screen.getByText(/shown, but these could not be read — pipeline gates, mentions/)).toBeTruthy();
  });

  it("excluded and partial companies coexist without either hiding the other", () => {
    render(
      <EnvelopeBanner
        companies={[
          co({ id: "c1", name: "Acme", partialSources: ["my tasks"] }),
          co({ id: "c2", name: "Beta", included: false, reason: "no_access" }),
        ]}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/can't view/);
    expect(text).toMatch(/incomplete/i);
    expect(text).toMatch(/Acme: shown, but these could not be read — my tasks/);
    expect(text).toMatch(/Beta: no access/);
  });

  it("partialSources on an EXCLUDED company is ignored — it already reports showing nothing", () => {
    // mergeLegs drops it, but the component must not double-report if one ever arrives: "you saw none
    // of this company" and "you saw part of it" are contradictory claims.
    render(<EnvelopeBanner companies={[co({ included: false, reason: "error", partialSources: ["mentions"] })]} />);
    expect(document.body.textContent).not.toMatch(/incomplete/i);
  });

  it("emits VALID html — the disclosure is not wrapped in a <p>", () => {
    // Regression for a hydration bug that survived the whole build because this banner only renders
    // when a read has actually FAILED, and in DEMO_MODE every fixture answers. It was a <p> wrapping
    // <details>/<summary>/<ul>/<li>; `<p>` accepts only phrasing content, so the parser closed it
    // early, reparented the rest, and React reported a mismatch on every render.
    //
    // Asserted structurally rather than by tag name alone: what must never be true is a block
    // element sitting inside a paragraph, whatever the wrapper happens to be called.
    const { container } = render(
      <EnvelopeBanner companies={[co({ included: false, reason: "no_access" })]} />,
    );
    for (const tag of ["details", "summary", "ul", "li"]) {
      expect(container.querySelector(`p ${tag}`), `<${tag}> must not be inside a <p>`).toBeNull();
    }
    // …and the disclosure really is present, so the assertion above cannot pass vacuously.
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("ul li")).not.toBeNull();
  });

  it("isUnderstated() is true for either shape — the one predicate a caller needs", () => {
    expect(isUnderstated([co({})])).toBe(false);
    expect(isUnderstated([co({ partialSources: ["mentions"] })])).toBe(true);
    expect(isUnderstated([co({ included: false, reason: "no_access" })])).toBe(true);
    // An empty array is not "understated" — it is a caller with no companies at all, which is a
    // different question and must not raise a warning banner.
    expect(isUnderstated([])).toBe(false);
  });
});
