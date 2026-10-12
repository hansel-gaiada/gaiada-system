// M6-P3d — unit tests for the MON-01 probe-target renderer. No database: the cross-tenant read is
// injected. The generator's own selftest cases are carried over here, then the writer's safety rules.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EMPTY_CONFIRMATIONS,
  PROBEABLE_SQL,
  isProbeableUrl,
  renderClientTargetsOnce,
  renderTargetsFile,
  sortRows,
  toFileSd,
  writeFileIfChanged,
  type PropertyRow,
} from "./client-targets";

const row = (over: Partial<PropertyRow> = {}): PropertyRow => ({
  domain: "a.example.com", site_url: "https://a.example.com", tenant_id: "t", client_id: "c", ...over,
});

describe("client-targets: selection and labels (the generator's selftest cases)", () => {
  it("a public https property becomes a target", () => {
    expect(toFileSd([row()]).targets).toHaveLength(1);
  });
  it("THE SSRF CASE: the cloud metadata endpoint is refused", () => {
    expect(toFileSd([row({ site_url: "http://169.254.169.254/latest/meta-data" })]).targets).toHaveLength(0);
  });
  it("RFC1918 hosts are refused", () => {
    for (const u of ["http://10.0.0.5", "http://192.168.1.1", "http://172.16.0.1", "http://172.31.255.1"]) {
      expect(toFileSd([row({ site_url: u })]).targets).toHaveLength(0);
    }
    // 172.32 is public space.
    expect(toFileSd([row({ site_url: "http://172.32.0.1" })]).targets).toHaveLength(1);
  });
  it("localhost, loopback, v6 loopback/unique-local, .internal and .local are refused", () => {
    for (const u of [
      "http://localhost:8080", "http://127.0.0.1", "http://[::1]/", "http://[fd12:3456::1]/",
      "https://svc.internal", "https://printer.local",
    ]) {
      expect(isProbeableUrl(u).ok).toBe(false);
    }
  });
  it("a non-http scheme and an unparseable URL are refused", () => {
    expect(toFileSd([row({ site_url: "file:///etc/passwd" })]).targets).toHaveLength(0);
    expect(isProbeableUrl("not a url")).toEqual({ ok: false, reason: "not a parseable URL" });
  });
  it("a skipped row is REPORTED, not silently dropped", () => {
    const { skipped } = toFileSd([row({ domain: "x", site_url: "http://10.0.0.5" })]);
    expect(skipped[0].domain).toBe("x");
    expect(skipped[0].reason).toContain("private");
  });
  it("optional topology labels are omitted when unknown", () => {
    const keys = Object.keys(toFileSd([row()]).targets[0].labels);
    expect(keys.sort()).toEqual(["client_id", "internal", "property_domain", "tenant_id"]);
  });
  it("topology labels appear when set", () => {
    const l = toFileSd([row({ hosting_provider: "hp", control_panel: "cp", stack: "wp" })]).targets[0].labels;
    expect(l).toMatchObject({ hosting_provider: "hp", control_panel: "cp", stack: "wp" });
  });
  it("internal label: true only for true; false for false, null and missing", () => {
    const lbl = (r: Partial<PropertyRow>) => toFileSd([row(r)]).targets[0].labels.internal;
    expect(lbl({ is_internal: true })).toBe("true");
    expect(lbl({ is_internal: false })).toBe("false");
    expect(lbl({ is_internal: null })).toBe("false");
    expect(lbl({})).toBe("false");
  });
  it("the consent gate is in the SQL, with a LEFT JOIN for internal", () => {
    expect(PROBEABLE_SQL).toMatch(/verified_at IS NOT NULL/);
    expect(PROBEABLE_SQL).toMatch(/status = 'active'/);
    expect(PROBEABLE_SQL).toMatch(/deleted_at IS NULL/);
    expect(PROBEABLE_SQL).toMatch(/LEFT JOIN clients/);
  });
  it("ordering is by domain, then id, independent of arrival order", () => {
    const sorted = sortRows([
      { domain: "b.example.com", id: "1" }, { domain: "a.example.com", id: "9" }, { domain: "a.example.com", id: "2" },
    ]);
    expect(sorted.map((r) => `${r.domain}/${r.id}`)).toEqual(["a.example.com/2", "a.example.com/9", "b.example.com/1"]);
  });
  it("renders the generator's byte shape: 2-space JSON plus a newline", () => {
    expect(renderTargetsFile([])).toBe("[]\n");
    const out = renderTargetsFile(toFileSd([row()]).targets);
    expect(out.endsWith("}\n")).toBe(false);
    expect(out.endsWith("]\n")).toBe(true);
    expect(out).toContain('\n    "targets": [');
  });
});

describe("client-targets: the atomic, change-only writer", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-"));
    file = path.join(dir, "client-properties.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a new file, then reports unchanged and does not touch it", async () => {
    expect(await writeFileIfChanged(file, "[]\n")).toBe("written");
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    expect(await writeFileIfChanged(file, "[]\n")).toBe("unchanged");
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });
  it("leaves no temp file behind and replaces content via rename", async () => {
    await writeFileIfChanged(file, "one\n");
    await writeFileIfChanged(file, "two\n");
    expect(await fs.readFile(file, "utf8")).toBe("two\n");
    expect(await fs.readdir(dir)).toEqual(["client-properties.json"]);
  });
  it("writes the temp file in the same directory and renames it into place", async () => {
    const spy = vi.spyOn(fs, "rename");
    await writeFileIfChanged(file, "x\n");
    expect(spy).toHaveBeenCalledTimes(1);
    const [from, to] = spy.mock.calls[0] as [string, string];
    expect(path.dirname(from)).toBe(dir);
    expect(to).toBe(file);
    spy.mockRestore();
  });
  it("does NOT create a missing directory (a missing bind mount is an error)", async () => {
    await expect(writeFileIfChanged(path.join(dir, "nope", "f.json"), "x")).rejects.toThrow();
  });
  it("a failed rename cleans the temp file and keeps the old content", async () => {
    await writeFileIfChanged(file, "old\n");
    const spy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("boom"));
    await expect(writeFileIfChanged(file, "new\n")).rejects.toThrow("boom");
    spy.mockRestore();
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
    expect(await fs.readdir(dir)).toEqual(["client-properties.json"]);
  });
});

describe("client-targets: a read error is never an empty list", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-"));
    file = path.join(dir, "client-properties.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a read failure throws and leaves a non-empty file untouched", async () => {
    await fs.writeFile(file, renderTargetsFile(toFileSd([row()]).targets));
    const before = await fs.readFile(file, "utf8");
    const state = { consecutiveEmpty: 0 };
    await expect(
      renderClientTargetsOnce(file, state, { read: async () => { throw new Error("db down"); } }),
    ).rejects.toThrow("db down");
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
  it("an empty result on a first run (no file) writes [] (the DB truly has nothing)", async () => {
    const r = await renderClientTargetsOnce(file, { consecutiveEmpty: 0 }, { read: async () => [] });
    expect(r.status).toBe("written");
    expect(await fs.readFile(file, "utf8")).toBe("[]\n");
  });
  it("empty over non-empty is held until it persists EMPTY_CONFIRMATIONS runs, then written", async () => {
    const full = renderTargetsFile(toFileSd([row()]).targets);
    await fs.writeFile(file, full);
    const state = { consecutiveEmpty: 0 };
    for (let i = 1; i < EMPTY_CONFIRMATIONS; i++) {
      const r = await renderClientTargetsOnce(file, state, { read: async () => [] });
      expect(r).toEqual({ status: "held-empty", consecutive: i });
      expect(await fs.readFile(file, "utf8")).toBe(full);
    }
    const last = await renderClientTargetsOnce(file, state, { read: async () => [] });
    expect(last.status).toBe("written");
    expect(await fs.readFile(file, "utf8")).toBe("[]\n");
  });
  it("a non-empty read in between resets the empty streak", async () => {
    const full = renderTargetsFile(toFileSd([row()]).targets);
    await fs.writeFile(file, full);
    const state = { consecutiveEmpty: 0 };
    await renderClientTargetsOnce(file, state, { read: async () => [] });
    expect(state.consecutiveEmpty).toBe(1);
    const r = await renderClientTargetsOnce(file, state, { read: async () => [row()] });
    expect(r.status).toBe("unchanged");
    expect(state.consecutiveEmpty).toBe(0);
  });
  it("rows that are all refused (private) count as empty, not as a crash", async () => {
    const r = await renderClientTargetsOnce(file, { consecutiveEmpty: 0 }, {
      read: async () => [row({ site_url: "http://10.0.0.5" })],
    });
    expect(r).toMatchObject({ status: "written", count: 0, skipped: 1 });
  });
});
