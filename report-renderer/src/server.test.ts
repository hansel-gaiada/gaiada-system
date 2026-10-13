// Acceptance-criteria test: "a token-less request -> 401". Deliberately does NOT exercise the
// chromium render path (that needs the Playwright browser binaries baked into the Docker image,
// unverified in this dev env — see the runbook) but the auth gate runs before any browser touch,
// so it is fully testable here with supertest against the plain Express app.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, buildFooterTemplate, DEFAULT_FOOTER_TEXT, MAX_FOOTER_TEXT, normalizeFooterText } from "./server.js";

describe("GET /health", () => {
  it("responds ok without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("POST /render auth gate", () => {
  it("rejects a token-less request with 401", async () => {
    const res = await request(app)
      .post("/render")
      .send({ url: "http://platform-ui:3005/print/reports/x" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong-token request with 401", async () => {
    const res = await request(app)
      .post("/render")
      .set("Authorization", "Bearer not-the-token")
      .send({ url: "http://platform-ui:3005/print/reports/x" });
    expect(res.status).toBe(401);
  });
});

describe("footer text (PV5-F1)", () => {
  it("defaults to a neutral text with no company name", () => {
    expect(buildFooterTemplate(undefined)).toContain(`<span>${DEFAULT_FOOTER_TEXT}</span>`);
    expect(buildFooterTemplate(undefined)).not.toContain("GAIADA");
    expect(normalizeFooterText(42)).toBe(DEFAULT_FOOTER_TEXT);
    expect(normalizeFooterText("   ")).toBe(DEFAULT_FOOTER_TEXT);
  });

  it("uses the requested text", () => {
    expect(buildFooterTemplate("Acme Ltd - INV-0001")).toContain("<span>Acme Ltd - INV-0001</span>");
  });

  it("HTML-escapes the text", () => {
    const t = buildFooterTemplate(`<img src=x onerror="a()">&'`);
    expect(t).not.toContain("<img");
    expect(t).toContain("&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;");
  });

  it("caps the length and strips control characters", () => {
    expect(normalizeFooterText("x".repeat(500)).length).toBe(MAX_FOOTER_TEXT);
    expect(normalizeFooterText("a\nb\u0000c")).toBe("a b c");
  });

  it("the auth gate still runs first with a footerText body", async () => {
    const res = await request(app).post("/render").send({ url: "http://platform-ui:3005/print/reports/x", footerText: "x" });
    expect(res.status).toBe(401);
  });
});
