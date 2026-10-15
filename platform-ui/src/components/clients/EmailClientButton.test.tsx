import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmailClientButton, NO_CONTACT_EMAIL } from "./EmailClientButton";

// DW-8j: "Email this client" (PV-confirmed: next to the primary contact, secondary style, reads as outside the portal).
afterEach(cleanup);

describe("EmailClientButton", () => {
  it("links to compose with the client and the primary contact address, labelled Email (Gmail)", () => {
    render(<EmailClientButton clientId="cl-1" email="ops@northwind.example" />);
    const a = screen.getByRole("link", { name: /Email \(Gmail\)/ });
    expect(a).toHaveAttribute("href", "/me/mail/new?to=ops%40northwind.example&client=cl-1");
    expect(a.className).toContain("lux-btn--ghost"); // never the primary style
  });

  it("is disabled with the reason when there is no contact email, and the reason is announced", () => {
    render(<EmailClientButton clientId="cl-1" email={null} />);
    const b = screen.getByRole("button", { name: "Email (Gmail)" });
    expect(b).toBeDisabled();
    expect(screen.queryByRole("link")).toBeNull();
    const why = b.getAttribute("aria-describedby");
    expect(why).toBeTruthy();
    expect(document.getElementById(why as string)?.textContent).toBe(NO_CONTACT_EMAIL);
    expect(NO_CONTACT_EMAIL).toBe("This client has no contact email");
    // accessible description is computed from the id reference
    expect(b).toHaveAccessibleDescription("This client has no contact email");
  });
});
