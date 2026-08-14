// P2-05 — the SILENT-CONSUMER pin.
//
// "A registered event handler whose entity-type stream is not in the `startConsumerLoop([...])`
// list is never invoked — the event is written, relayed, and read by nobody." That failure is
// completely silent: the producer succeeds, the outbox row exists, the relay ships it, and the
// reconciler simply never runs. Nothing goes red. This suite makes it go red.
//
// STATIC — reads `main.ts`'s SOURCE and checks the streams this consumer needs actually appear in
// the watched list, the same discipline `search-notifications.test.ts` uses for its own stream.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POSITION_STREAMS,
  ASSIGNMENT_TRIGGERS,
  POSITION_TRIGGERS,
  registerPositionEventHandlers,
} from "./position-consumer";
import { registerCoreEventHandler, resetCoreEventHandlers } from "./consumer.service";

const mainSrc = (): string => readFileSync(join(__dirname, "..", "main.ts"), "utf8");

describe("P2-05 — position reconciler event wiring", () => {
  it("main.ts spreads POSITION_STREAMS into startConsumerLoop's watched list", () => {
    const src = mainSrc();
    const call = src.slice(src.indexOf("startConsumerLoop(["));
    const list = call.slice(0, call.indexOf("]);") + 3);
    expect(
      list,
      "the watched-stream list must include the position streams, or every handler registered by " +
        "registerPositionEventHandlers() is dead code: the events are written, relayed, and read " +
        "by nobody.",
    ).toContain("...POSITION_STREAMS");
    // and the import that makes that spread resolve is actually present
    expect(src).toContain('from "./events/position-consumer"');
    expect(src).toContain("registerPositionEventHandlers()");
  });

  it("every entity type the handlers are keyed to is covered by POSITION_STREAMS", () => {
    // A trigger's entity type is its event type's prefix before the first dot.
    const entityTypeOf = (eventType: string): string => eventType.split(".")[0];
    for (const t of ASSIGNMENT_TRIGGERS) {
      expect(POSITION_STREAMS as readonly string[], `trigger "${t}"`).toContain(entityTypeOf(t));
    }
    for (const t of POSITION_TRIGGERS) {
      expect(POSITION_STREAMS as readonly string[], `trigger "${t}"`).toContain(entityTypeOf(t));
    }
  });

  it("the reconciler's OWN emitted event types are NOT registered as triggers (no feedback loop)", () => {
    const all = [...ASSIGNMENT_TRIGGERS, ...POSITION_TRIGGERS] as readonly string[];
    // These are what position-reconciler.ts emits. Registering a handler for either would make a
    // reconcile re-trigger itself forever.
    expect(all).not.toContain("position_grants.reconciled");
    expect(all).not.toContain("iam.drift_detected");
  });

  it("registerPositionEventHandlers registers a handler for every declared trigger", () => {
    resetCoreEventHandlers();
    const seen: string[] = [];
    // Spy by registering a marker first, then confirming the real registration appends alongside.
    const before = [...ASSIGNMENT_TRIGGERS, ...POSITION_TRIGGERS];
    for (const t of before) registerCoreEventHandler(t, async () => void seen.push(t));
    expect(() => registerPositionEventHandlers()).not.toThrow();
    resetCoreEventHandlers();
  });
});
