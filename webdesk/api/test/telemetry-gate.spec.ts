// M4 telemetry — the gate: OFF unless BOTH flags are exactly true AND a valid endpoint is set; off means the
// SDK is never loaded. Strict parsing (an empty env var must never become "on").
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { evaluateTelemetryGate, isTruthyFlag, parseOtlpHeaders, type Env } from "../src/telemetry/gate";
import { initTelemetry, shutdownTelemetry } from "../src/telemetry";

const FULL: Env = {
  OTEL_ENABLED: "true",
  WEBDESK_OTEL_ZONEA_PUSH_ENABLED: "true",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://172.17.0.1:4319",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer wdotlp_abc",
};

describe("isTruthyFlag — strict", () => {
  it.each(["true", "TRUE", " True ", "1", " 1\n"])("%j is on", (v) => expect(isTruthyFlag(v)).toBe(true));
  it.each([undefined, "", " ", "false", "0", "no", "yes", "on", "off", "2", "truee", "t", "null", "undefined"])("%j is off", (v) => expect(isTruthyFlag(v)).toBe(false));
});

describe("evaluateTelemetryGate", () => {
  it("is off with an empty environment, and with the compose defaults (false, false, empty endpoint, empty headers)", () => {
    expect(evaluateTelemetryGate({}).enabled).toBe(false);
    expect(evaluateTelemetryGate({ OTEL_ENABLED: "false", WEBDESK_OTEL_ZONEA_PUSH_ENABLED: "false", OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_HEADERS: "" }).enabled).toBe(false);
  });

  it("is on only for the full combination, and says where it will send", () => {
    const g = evaluateTelemetryGate(FULL);
    expect(g).toEqual({ enabled: true, tracesUrl: "http://172.17.0.1:4319/v1/traces", headers: { Authorization: "Bearer wdotlp_abc" } });
  });

  // every one of the 2^3 flag/endpoint combinations except all-three-set stays off
  it.each([0, 1, 2, 3, 4, 5, 6])("combination %i of {OTEL_ENABLED, ZONEA_PUSH, endpoint} (not all three) stays off", (mask) => {
    const env: Record<string, string> = {};
    if (mask & 1) env.OTEL_ENABLED = "true";
    if (mask & 2) env.WEBDESK_OTEL_ZONEA_PUSH_ENABLED = "true";
    if (mask & 4) env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://172.17.0.1:4319";
    expect(evaluateTelemetryGate(env).enabled).toBe(false);
  });

  it("each flag alone is not enough even with the endpoint and headers set", () => {
    expect(evaluateTelemetryGate({ ...FULL, OTEL_ENABLED: "false" }).enabled).toBe(false);
    expect(evaluateTelemetryGate({ ...FULL, WEBDESK_OTEL_ZONEA_PUSH_ENABLED: "" }).enabled).toBe(false);
    expect(evaluateTelemetryGate({ ...FULL, WEBDESK_OTEL_ZONEA_PUSH_ENABLED: undefined }).enabled).toBe(false);
  });

  it("an empty, blank, non-http or unparseable endpoint is no endpoint", () => {
    for (const v of ["", "   ", "172.17.0.1:4319", "grpc://x:4317", "file:///etc/passwd", "not a url", "http://"]) {
      expect(evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_ENDPOINT: v }).enabled, JSON.stringify(v)).toBe(false);
    }
  });

  it("only http/protobuf is spoken: another protocol keeps it off, http/protobuf (any case) or unset is fine", () => {
    expect(evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }).enabled).toBe(false);
    expect(evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }).enabled).toBe(false);
    expect(evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_PROTOCOL: "HTTP/Protobuf" }).enabled).toBe(true);
    expect(evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_PROTOCOL: "" }).enabled).toBe(true);
  });

  it("the standard traces-specific endpoint is used whole; the generic one gets /v1/traces (trailing slashes tolerated)", () => {
    const a = evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/custom/path" });
    expect(a.enabled && a.tracesUrl).toBe("https://collector.example/custom/path");
    const b = evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_ENDPOINT: "http://172.17.0.1:4319///" });
    expect(b.enabled && b.tracesUrl).toBe("http://172.17.0.1:4319/v1/traces");
  });

  it("enabled without any headers is allowed (the receiver will refuse; that is the collector's call), headers parse as key=value pairs", () => {
    const g = evaluateTelemetryGate({ ...FULL, OTEL_EXPORTER_OTLP_HEADERS: "" });
    expect(g.enabled && g.headers).toEqual({});
    expect(parseOtlpHeaders("Authorization=Bearer a=b, x-team = core ,broken,=novalue,bad key=1")).toEqual({ Authorization: "Bearer a=b", "x-team": "core" });
    expect(parseOtlpHeaders("a=%20x%zz")).toEqual({ a: "%20x%zz" }); // an invalid escape is kept literally, never thrown on
  });
});

describe("initTelemetry — off means the SDK is not even loaded", () => {
  it("never calls the loader while the gate is off, for any partial combination, and reports false", async () => {
    const load = vi.fn();
    for (const env of [{}, { OTEL_ENABLED: "true" }, { WEBDESK_OTEL_ZONEA_PUSH_ENABLED: "true" }, { OTEL_ENABLED: "true", WEBDESK_OTEL_ZONEA_PUSH_ENABLED: "true" }, { ...FULL, OTEL_ENABLED: "" }]) {
      expect(await initTelemetry(env, { load: load as never })).toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("calls the loader once when fully enabled, and passes the parsed gate to the SDK", async () => {
    const startTelemetry = vi.fn(() => ({ shutdown: vi.fn(async () => undefined), forceFlush: vi.fn(async () => undefined) }));
    const load = vi.fn(async () => ({ startTelemetry }) as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await initTelemetry(FULL, { load, warn: () => undefined })).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(startTelemetry).toHaveBeenCalledTimes(1);
    expect((startTelemetry.mock.calls[0] as unknown as [{ gate: { tracesUrl: string } }])[0].gate.tracesUrl).toBe("http://172.17.0.1:4319/v1/traces");
    await shutdownTelemetry();
  });

  it("a loader or SDK failure is a warning and `false`, never a throw, and the warning carries no endpoint or token", async () => {
    const warn = vi.fn();
    const load = vi.fn(async () => {
      throw new Error("boom http://172.17.0.1:4319 wdotlp_abc");
    });
    await expect(initTelemetry(FULL, { load: load as never, warn })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).not.toContain("172.17.0.1");
    expect(msg).not.toContain("wdotlp_abc");
  });

  it("shutdownTelemetry is a no-op that never throws when nothing started", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe("zero overhead when off — checked in a fresh process", () => {
  it("initTelemetry with telemetry off loads no @opentelemetry module and starts nothing", () => {
    const root = join(__dirname, "..");
    const script = [
      "const { initTelemetry } = require('./src/telemetry');",
      "initTelemetry({}).then((on) => {",
      "  const otel = Object.keys(require.cache).filter((k) => k.includes('@opentelemetry') || k.includes('@fastify' + require('path').sep + 'otel'));",
      "  console.log(JSON.stringify({ on, otel: otel.length }));",
      "});",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, OTEL_ENABLED: "", WEBDESK_OTEL_ZONEA_PUSH_ENABLED: "" } });
    expect(res.stderr).not.toMatch(/Error/);
    const line = res.stdout.trim().split("\n").pop() ?? "";
    expect(JSON.parse(line)).toEqual({ on: false, otel: 0 });
  }, 60_000);

  it("positive control: the same probe does count modules once the SDK file is loaded", () => {
    const root = join(__dirname, "..");
    const script = [
      "require('./src/telemetry/sdk');",
      "const otel = Object.keys(require.cache).filter((k) => k.includes('@opentelemetry'));",
      "console.log(JSON.stringify({ otel: otel.length > 20 }));",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}")).toEqual({ otel: true });
  }, 60_000);
});
