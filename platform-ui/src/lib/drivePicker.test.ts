import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GAPI_SRC, openDrivePicker, resetDrivePickerLoader } from "./drivePicker";

// DW-6i UI: the Google loader, tested with a fake `window.gapi` and `window.google.picker`. It loads the script once, builds the
// Picker with the token, key and app id it was given, and returns every picked id (none for a cancel).

type Cb = (data: Record<string, unknown>) => void;
interface Built { token?: string; key?: string; appId?: string; views: unknown[]; features: unknown[]; cb?: Cb; visible?: boolean }

let built: Built[];
let scripts: HTMLScriptElement[];
let gapiLoad: ReturnType<typeof vi.fn>;
let appendSpy: { mockRestore(): void; mockImplementationOnce(fn: (el: Node) => Node): unknown };

function installFakeGoogle() {
  class FakeBuilder {
    b: Built = { views: [], features: [] };
    addView(v: unknown) { this.b.views.push(v); return this; }
    enableFeature(f: unknown) { this.b.features.push(f); return this; }
    setOAuthToken(t: string) { this.b.token = t; return this; }
    setDeveloperKey(k: string) { this.b.key = k; return this; }
    setAppId(a: string) { this.b.appId = a; return this; }
    setCallback(cb: Cb) { this.b.cb = cb; return this; }
    build() {
      const b = this.b;
      built.push(b);
      return { setVisible: (v: boolean) => { b.visible = v; } };
    }
  }
  (window as unknown as { google: unknown }).google = {
    picker: {
      PickerBuilder: FakeBuilder,
      ViewId: { DOCS: "docs-view" },
      Feature: { MULTISELECT_ENABLED: "multi" },
      Action: { PICKED: "picked", CANCEL: "cancel" },
      Response: { ACTION: "action", DOCUMENTS: "docs" },
      Document: { ID: "id" },
    },
  };
}

beforeEach(() => {
  built = [];
  scripts = [];
  resetDrivePickerLoader();
  delete (window as unknown as { gapi?: unknown }).gapi;
  delete (window as unknown as { google?: unknown }).google;
  gapiLoad = vi.fn((api: string, o: { callback: () => void }) => {
    if (api === "picker") installFakeGoogle();
    o.callback();
  });
  // jsdom never fetches a script, so the "network" is this: the append installs the fake `gapi` and fires onload.
  appendSpy = vi.spyOn(document.head, "appendChild").mockImplementation(((el: Node) => {
    const s = el as HTMLScriptElement;
    scripts.push(s);
    (window as unknown as { gapi: unknown }).gapi = { load: gapiLoad };
    queueMicrotask(() => s.onload?.(new Event("load")));
    return el;
  }) as never);
});

afterEach(() => {
  appendSpy.mockRestore();
});

const creds = { accessToken: "ya29.tok", apiKey: "key-1", appId: "proj-9" };
const pickNow = async (p: Promise<string[]>, action: Record<string, unknown>) => {
  const before = built.length; // measured in the same tick the call began: the new Picker is the one built after this
  await vi.waitFor(() => expect(built.length).toBeGreaterThan(before));
  built[built.length - 1].cb!(action);
  return p;
};

describe("openDrivePicker", () => {
  it("loads Google's script on the first call, then the picker API, and builds with the token, key and app id", async () => {
    const p = openDrivePicker(creds);
    const ids = await pickNow(p, { action: "picked", docs: [{ id: "f1" }] });
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(GAPI_SRC);
    expect(scripts[0].async).toBe(true);
    expect(gapiLoad).toHaveBeenCalledWith("picker", expect.objectContaining({ callback: expect.any(Function) }));
    expect(built[0]).toMatchObject({ token: "ya29.tok", key: "key-1", appId: "proj-9", views: ["docs-view"], features: ["multi"], visible: true });
    expect(ids).toEqual(["f1"]);
  });

  it("loads the script and the picker API only once across clicks", async () => {
    await pickNow(openDrivePicker(creds), { action: "picked", docs: [{ id: "a" }] });
    await pickNow(openDrivePicker({ ...creds, accessToken: "fresh" }), { action: "picked", docs: [{ id: "b" }] });
    expect(scripts).toHaveLength(1);
    expect(gapiLoad).toHaveBeenCalledTimes(1);
    expect(built).toHaveLength(2);
    expect(built[1].token).toBe("fresh");
  });

  it("does not inject the script when Google's is already on the page", async () => {
    (window as unknown as { gapi: unknown }).gapi = { load: gapiLoad };
    await pickNow(openDrivePicker(creds), { action: "picked", docs: [{ id: "a" }] });
    expect(scripts).toHaveLength(0);
  });

  it("returns every picked id, in order, and skips a document with no id", async () => {
    const ids = await pickNow(openDrivePicker(creds), { action: "picked", docs: [{ id: "a" }, { id: "b" }, { name: "no id" }, { id: "c" }] });
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for a cancel, and ignores the Picker's other callbacks", async () => {
    const p = openDrivePicker(creds);
    await vi.waitFor(() => expect(built.length).toBe(1));
    built[0].cb!({ action: "loaded" });
    built[0].cb!({ action: "cancel" });
    expect(await p).toEqual([]);
  });

  it("rejects when the script cannot be loaded, and tries again on the next call", async () => {
    appendSpy.mockImplementationOnce(((el: Node) => {
      queueMicrotask(() => (el as HTMLScriptElement).onerror?.(new Event("error")));
      return el;
    }) as never);
    await expect(openDrivePicker(creds)).rejects.toThrow(/could not be loaded/);
    const ids = await pickNow(openDrivePicker(creds), { action: "picked", docs: [{ id: "x" }] });
    expect(ids).toEqual(["x"]);
  });

  it("never writes the token to storage or the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await pickNow(openDrivePicker(creds), { action: "picked", docs: [{ id: "a" }] });
    expect(JSON.stringify(Object.entries(window.localStorage))).not.toContain("ya29");
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain("ya29");
    expect(JSON.stringify([...log.mock.calls, ...err.mock.calls])).not.toContain("ya29");
    log.mockRestore();
    err.mockRestore();
  });
});
