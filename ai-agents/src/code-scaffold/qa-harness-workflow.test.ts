import { describe, it, expect } from "vitest";
import { generateQaHarnessWorkflow, qaHarnessWorkflowFilePath } from "./qa-harness-workflow";

describe("generateQaHarnessWorkflow", () => {
  const yml = generateQaHarnessWorkflow({});

  it("is a real GitHub Actions workflow that runs the generated conformance test", () => {
    expect(yml).toContain("runs-on: ubuntu-latest");
    expect(yml).toContain("npm run test");
  });

  it("gates on an actual compile step before the test step (§06: 'a repo that compiles')", () => {
    const buildIdx = yml.indexOf("npm run build");
    const testIdx = yml.indexOf("npm run test");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(testIdx);
  });

  it("pre-wires the signed-webhook target (wd-qa-intake) even though the receiver is unbuilt", () => {
    expect(yml).toContain("QA_HARNESS_WEBHOOK_URL");
    expect(yml).toContain("QA_HARNESS_WEBHOOK_SECRET");
    expect(yml).toMatch(/X-Signature/);
    expect(yml).toContain("hmac");
  });

  it("degrades to a skip, not a failure, when the webhook target is not configured yet", () => {
    expect(yml).toContain("not live yet");
    expect(yml).toContain("continue-on-error: true");
  });

  it("names the P5 drop-in point explicitly so the file needs no change when the harness lands", () => {
    expect(yml).toMatch(/TODO\(webdev P5\)/);
  });

  it("lands at .github/workflows/qa-harness.yml", () => {
    expect(qaHarnessWorkflowFilePath()).toBe(".github/workflows/qa-harness.yml");
  });
});
