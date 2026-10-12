import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PortalAmendmentBanner } from "./PortalAmendmentBanner";

// PV4-08 — the amendment banner on the contract detail page (§16b: kind / amendsReference / changeRequestId).
describe("PortalAmendmentBanner", () => {
  it("renders nothing for an ordinary agreement, or one from an older server", () => {
    const a = render(<PortalAmendmentBanner contract={{ kind: "agreement", amendsId: null, amendsReference: null, changeRequestId: null }} />);
    expect(a.container).toBeEmptyDOMElement();
    const b = render(<PortalAmendmentBanner contract={{}} />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it("names the amended contract by reference and links to it", () => {
    render(<PortalAmendmentBanner contract={{ kind: "amendment", amendsId: "k-1", amendsReference: "GDA-2026-004", changeRequestId: null }} />);
    expect(screen.getByText(/Amendment to/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GDA-2026-004" })).toHaveAttribute("href", "/portal/contracts/k-1");
    expect(screen.queryByText("From your request")).not.toBeInTheDocument();
  });

  it("adds 'From your request' with a link when the amendment came from one", () => {
    render(<PortalAmendmentBanner contract={{ kind: "amendment", amendsId: "k-1", amendsReference: "GDA-2026-004", changeRequestId: "cr-1" }} />);
    expect(screen.getByRole("link", { name: "From your request" })).toHaveAttribute("href", "/portal/requests");
  });

  it("when the amended contract is out of the caller's reach (null), says so without naming anything", () => {
    render(<PortalAmendmentBanner contract={{ kind: "amendment", amendsId: null, amendsReference: null, changeRequestId: null }} />);
    expect(screen.getByText("Amendment to an earlier agreement")).toBeInTheDocument();
  });
});
