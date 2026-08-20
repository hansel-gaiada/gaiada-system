// SMM-13/SMM-14 — the SILENT-CONSUMER pin, this module's own copy of the discipline
// `src/events/position-consumer.test.ts` established for P2-05 and this module's own header
// warns about by name (platform-nest/CLAUDE.md: "A registered event handler whose entity-type
// stream is not in the `startConsumerLoop([...])` list is never invoked — the event is written,
// relayed, and read by nobody. Add the stream.")
//
// `event-handlers.ts` registers `handlePostDispatched` / `handlePostPublished` / `handlePostFailed`
// against `social.controller.ts`'s module contract (`socialModule.eventHandlers`), keyed to events
// emitted with entity type `"social_post_variant"` (see `dispatch.ts`'s three `emitEvent(c,
// tenantId, "social_post_variant", ...)` calls). `event-handlers.test.ts` calls those handler
// functions DIRECTLY and passes — which proves the handler bodies are correct, and proves NOTHING
// about whether the real relay ever calls them. Only `main.ts`'s `startConsumerLoop([...])` array
// decides whether the `events:social_post_variant` Redis stream is ever drained at all.
//
// STATIC — reads `main.ts`'s SOURCE, the same discipline `position-consumer.test.ts` uses for its
// own stream, so this pin cannot itself be defeated by a mock relay/consumer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mainSrc = (): string => readFileSync(join(__dirname, "..", "..", "main.ts"), "utf8");

describe("SMM-13 — social post event wiring (event-handlers.ts is dead code without this)", () => {
  it("main.ts's startConsumerLoop([...]) watched-stream list includes \"social_post_variant\"", () => {
    const src = mainSrc();
    const start = src.indexOf("startConsumerLoop([");
    expect(start, "startConsumerLoop([...]) call not found in main.ts").toBeGreaterThan(-1);
    const call = src.slice(start);
    const list = call.slice(0, call.indexOf("]);") + 3);
    expect(
      list,
      "the watched-stream list must include \"social_post_variant\", or every handler " +
        "socialModule.eventHandlers registers (handlePostDispatched/handlePostPublished/" +
        "handlePostFailed, event-handlers.ts) is dead code: social.post.dispatched/published/failed " +
        "events are written to the outbox, relayed to events:social_post_variant, and read by " +
        "nobody — no in-app notification and no risk-shaped mail ever fires in the running app, " +
        "even though event-handlers.test.ts is green (it calls the handler functions directly, " +
        "bypassing the consumer loop entirely).",
    ).toContain("social_post_variant");
  });
});
