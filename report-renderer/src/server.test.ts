// Acceptance-criteria test: "a token-less request -> 401". Deliberately does NOT exercise the
// chromium render path (that needs the Playwright browser binaries baked into the Docker image,
// unverified in this dev env — see the runbook) but the auth gate runs before any browser touch,
// so it is fully testable here with supertest against the plain Express app.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "./server.js";

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
