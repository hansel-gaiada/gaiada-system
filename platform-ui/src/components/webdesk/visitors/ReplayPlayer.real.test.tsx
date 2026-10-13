import { describe, it, expect, afterEach, vi } from "vitest";
import Player from "rrweb-player";
import { REPLAYER_PROPS } from "./ReplayPlayer";

// The REAL rrweb-player (2.1.6) with this app's replayer props, in jsdom: the iframe the replayed page lives in is sandboxed to
// `allow-same-origin` ONLY. If a dependency bump ever adds `allow-scripts` (or someone passes UNSAFE_replayCanvas), this fails.
// Fake timers: jsdom has no `iframe.sandbox`, so rrweb's own guard (it refuses to rebuild a page into an iframe it cannot prove
// sandboxed) would throw from the replayer's first timer. We only need the iframe the replayer CREATES, which exists synchronously.
// What this does NOT prove: that a recorded page replays correctly. That needs a real browser and a real recording (the gate stack).

const doc = { type: 0, childNodes: [
  { type: 1, name: "html", publicId: "", systemId: "", id: 2 },
  { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [
    { type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] },
    { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [
      { type: 2, tagName: "p", attributes: {}, id: 6, childNodes: [{ type: 3, textContent: "hello", id: 7 }] },
      { type: 2, tagName: "script", attributes: {}, id: 8, childNodes: [{ type: 3, textContent: "window.__ran = true", id: 9 }] },
    ] },
  ] },
], id: 1 };
const events = [
  { type: 4, data: { href: "https://gaiada.com/", width: 800, height: 600 }, timestamp: 1000 },
  { type: 2, data: { node: doc, initialOffset: { left: 0, top: 0 } }, timestamp: 1001 },
  { type: 3, data: { source: 1, positions: [{ x: 1, y: 1, id: 6, timeOffset: 0 }] }, timestamp: 2000 },
];

let host: HTMLDivElement | null = null;
afterEach(() => { host?.remove(); host = null; vi.useRealTimers(); });

/** The sandbox tokens of every iframe the replayer creates, for the given extra props. */
function sandboxes(extra: Record<string, unknown> = {}): string[][] {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  // jsdom has no layout or ResizeObserver; the replayer only needs them to size itself.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const p = new Player({ target: host, props: { events: events as never, width: 400, height: 300, ...REPLAYER_PROPS, autoPlay: false, ...extra } });
  const out = [...host.querySelectorAll("iframe")].map((f) => (f.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean));
  (p as unknown as { $destroy?: () => void }).$destroy?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  return out;
}

describe("rrweb-player as configured here", () => {
  it("replays into an iframe sandboxed to allow-same-origin only: no scripts, forms, popups or navigation", () => {
    const frames = sandboxes();
    expect(frames.length).toBeGreaterThan(0);
    for (const tokens of frames) expect(tokens).toEqual(["allow-same-origin"]);
  });

  it("control: the one switch that would add allow-scripts (UNSAFE_replayCanvas) does show up here, so the check above can fail", () => {
    const frames = sandboxes({ UNSAFE_replayCanvas: true });
    expect(frames.some((t) => t.includes("allow-scripts"))).toBe(true);
  });

  it("our props pin the switches that matter", () => {
    expect(REPLAYER_PROPS.UNSAFE_replayCanvas).toBe(false);
    expect(Object.keys(REPLAYER_PROPS)).not.toContain("insertStyleRules");
  });
});
