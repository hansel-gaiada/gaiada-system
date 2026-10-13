import { describe, expect, it } from "vitest";
import * as pkg from "./index";

describe("webdesk/deploy is retired and fails closed", () => {
  it("deploy() rejects with a message naming the replacement", async () => {
    await expect(pkg.deploy("staging", "/tmp/dist")).rejects.toThrow(/retired/);
    await expect(pkg.deploy("staging", "/tmp/dist")).rejects.toThrow(/site's own CI/);
    await expect(pkg.deploy("staging", "/tmp/dist")).rejects.toThrow(/deploy\.sh/);
    await expect(pkg.deploy("staging", "/tmp/dist")).rejects.toThrow(/WSK-D79/);
    await expect(pkg.deploy()).rejects.toBeInstanceOf(pkg.DeployRetiredError);
  });

  it("probe() rejects too, and getDriver() hands back the same refusals", async () => {
    await expect(pkg.probe("production")).rejects.toBeInstanceOf(pkg.DeployRetiredError);
    const d = pkg.getDriver();
    await expect(d.deploy("production", "/x")).rejects.toThrow(/retired/);
    await expect(d.probe("staging")).rejects.toThrow(/retired/);
  });

  it("exports no driver, host config or transport", () => {
    expect(Object.keys(pkg).sort()).toEqual(["DeployRetiredError", "RETIRED_MESSAGE", "deploy", "getDriver", "probe"]);
  });
});
