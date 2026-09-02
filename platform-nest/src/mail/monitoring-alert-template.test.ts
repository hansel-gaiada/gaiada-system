// The monitoring alert template renders both states with the right content — this is what an
// operator actually reads when a site goes down, so it is worth pinning.
import { describe, it, expect } from "vitest";
import { renderTemplate } from "./templates";

describe("monitoring.alert template", () => {
  it("renders a DOWN alert with site, target and reason", () => {
    const m = renderTemplate("monitoring.alert", {
      event: "opened",
      siteName: "Akoya Spa",
      target: "https://akoyaspabali.com",
      status: "down",
      reason: "HTTP 503",
      href: "https://erp.gaiada.online/monitoring/abc",
    });
    expect(m.subject).toContain("Akoya Spa");
    expect(m.subject.toLowerCase()).toContain("down");
    expect(m.text).toContain("akoyaspabali.com");
    expect(m.text).toContain("HTTP 503");
    expect(m.html).toContain("Open the monitor");
    // The link the operator clicks to investigate.
    expect(m.html).toContain("/monitoring/abc");
  });

  it("renders a recovery notice without a reason line", () => {
    const m = renderTemplate("monitoring.alert", {
      event: "closed",
      siteName: "Akoya Spa",
      target: "https://akoyaspabali.com",
      status: "up",
      reason: null,
      href: "https://erp.gaiada.online/monitoring/abc",
    });
    expect(m.subject.toLowerCase()).toMatch(/recover|ok/);
    expect(m.text.toLowerCase()).toContain("back up");
    expect(m.text).not.toContain("Reason:");
  });

  it("escapes HTML in the site name — the name is not trusted markup", () => {
    const m = renderTemplate("monitoring.alert", {
      event: "opened",
      siteName: "<script>x</script>",
      target: "https://x.test",
      status: "down",
      href: "https://erp.gaiada.online/monitoring/abc",
    });
    expect(m.html).not.toContain("<script>x</script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});
