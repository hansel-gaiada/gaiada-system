import { describe, it, expect } from "vitest";
import { hashId } from "./office";
import {
  AGENT_SPRITES, AUTOMATION_SPRITES, PEOPLE_PROP_SPRITES, CHAR_PX, CHAR_DRAW_SCALE,
  agentSpritePath, automationSpritePath, personPropSpritePath, activeBobPx, walkBobPx,
} from "./officeChars";

describe("officeChars — sprite selection is deterministic, or an avatar changes identity on reload", () => {
  it("returns the SAME sprite for the same id, every time", () => {
    for (const id of ["agent-supervisor", "wf-42", "a", ""]) {
      expect(agentSpritePath(id, hashId)).toBe(agentSpritePath(id, hashId));
      expect(automationSpritePath(id, hashId)).toBe(automationSpritePath(id, hashId));
    }
  });

  it("only ever returns a path from its own list — never a cross-kind sprite", () => {
    // An automation rendered as an android (or vice versa) would misreport what kind of principal
    // is at that desk, which is the one thing the avatar exists to communicate.
    for (let i = 0; i < 200; i++) {
      expect(AGENT_SPRITES).toContain(agentSpritePath(`agent-${i}`, hashId));
      expect(AUTOMATION_SPRITES).toContain(automationSpritePath(`wf-${i}`, hashId));
    }
  });

  it("spreads across the whole list rather than collapsing onto one sprite", () => {
    // Guards the failure where a hash keeps landing on index 0 and every automation in the office
    // is the same cat — which reads as a rendering bug, not as twelve automations.
    const seen = new Set(Array.from({ length: 300 }, (_, i) => automationSpritePath(`wf-${i}`, hashId)));
    expect(seen.size).toBe(AUTOMATION_SPRITES.length);
    const agents = new Set(Array.from({ length: 200 }, (_, i) => agentSpritePath(`agent-${i}`, hashId)));
    expect(agents.size).toBe(AGENT_SPRITES.length);
  });

  it("every declared path points into the committed pack, with no duplicates", () => {
    const all = [...AGENT_SPRITES, ...AUTOMATION_SPRITES];
    expect(new Set(all).size).toBe(all.length);
    for (const p of AGENT_SPRITES) expect(p.startsWith("/office-chars/agents/")).toBe(true);
    for (const p of AUTOMATION_SPRITES) expect(p.startsWith("/office-chars/automations/")).toBe(true);
    for (const p of all) expect(p.endsWith(".png")).toBe(true);
  });

  it("pools cats and dogs — the split is a folder convention, not twelve of one animal", () => {
    const cats = AUTOMATION_SPRITES.filter((p) => p.includes("/cats/"));
    const dogs = AUTOMATION_SPRITES.filter((p) => p.includes("/dogs/"));
    expect(cats.length).toBe(6);
    expect(dogs.length).toBe(6);
  });
});

describe("personPropSpritePath — a human's own desk item (owner feedback 2026-08-26: 'identical people')", () => {
  it("returns the SAME item for the same id, every time", () => {
    for (const id of ["person-1", "gede-ic", "a", ""]) {
      expect(personPropSpritePath(id, hashId)).toBe(personPropSpritePath(id, hashId));
    }
  });

  it("only ever returns a path from its own pool", () => {
    for (let i = 0; i < 200; i++) {
      expect(PEOPLE_PROP_SPRITES).toContain(personPropSpritePath(`person-${i}`, hashId));
    }
  });

  it("spreads across the whole pool rather than collapsing onto one item", () => {
    const seen = new Set(Array.from({ length: 400 }, (_, i) => personPropSpritePath(`person-${i}`, hashId)));
    expect(seen.size).toBe(PEOPLE_PROP_SPRITES.length);
  });

  it("pools BOTH previously-unwired directories — 30 uniform + 6 skin, no duplicates", () => {
    expect(new Set(PEOPLE_PROP_SPRITES).size).toBe(PEOPLE_PROP_SPRITES.length);
    const uniform = PEOPLE_PROP_SPRITES.filter((p) => p.startsWith("/office-chars/people/uniform/"));
    const skin = PEOPLE_PROP_SPRITES.filter((p) => p.startsWith("/office-chars/people/skin/"));
    expect(uniform.length).toBe(30);
    expect(skin.length).toBe(6);
    expect(uniform.length + skin.length).toBe(PEOPLE_PROP_SPRITES.length);
    for (const p of PEOPLE_PROP_SPRITES) expect(p.endsWith(".png")).toBe(true);
  });

  it("never collides with the agent/automation pools — a person's desk item never doubles as a body sprite", () => {
    const overlap = PEOPLE_PROP_SPRITES.filter((p) => (AGENT_SPRITES as readonly string[]).includes(p) || (AUTOMATION_SPRITES as readonly string[]).includes(p));
    expect(overlap).toEqual([]);
  });
});

describe("activeBobPx — the two-frame animation, and the claim it makes", () => {
  it("is ZERO whenever the principal is not active, on either pulse beat", () => {
    // Stillness is the default and the only state we can always support. A desk must never bob
    // while claiming to be idle.
    expect(activeBobPx(false, false)).toBe(0);
    expect(activeBobPx(false, true)).toBe(0);
  });

  it("lifts by exactly one SPRITE pixel when active, alternating with the pulse", () => {
    expect(activeBobPx(true, false)).toBe(0);
    expect(activeBobPx(true, true)).toBe(CHAR_DRAW_SCALE);
  });

  it("moves in whole sprite pixels, so the pixel grid survives the animation", () => {
    expect(activeBobPx(true, true) % CHAR_DRAW_SCALE).toBe(0);
    expect(Number.isInteger(CHAR_DRAW_SCALE)).toBe(true);
    expect(CHAR_PX * CHAR_DRAW_SCALE).toBe(64); // two tiles, matching the LPC humans beside them
  });
});

describe("walkBobPx — a walk cycle for a sprite with no walk frames", () => {
  it("is ZERO when not in transit, wherever the sprite is standing", () => {
    for (const x of [0, 7, 123, 4096]) expect(walkBobPx(false, x)).toBe(0);
  });

  it("alternates with DISTANCE, so a longer route takes more steps than a shorter one", () => {
    // The property that matters: the bob is a function of position, not of time. Count the
    // transitions across a long crossing and a short one — the long one must have more.
    const count = (from: number, to: number) => {
      let flips = 0, prev = walkBobPx(true, from);
      for (let x = from; x <= to; x++) {
        const v = walkBobPx(true, x);
        if (v !== prev) flips++;
        prev = v;
      }
      return flips;
    };
    expect(count(0, 400)).toBeGreaterThan(count(0, 40));
  });

  it("returns only whole sprite pixels, never a subpixel that would blur the art", () => {
    for (let x = 0; x < 200; x++) {
      const v = walkBobPx(true, x);
      expect(v === 0 || v === CHAR_DRAW_SCALE).toBe(true);
    }
  });

  it("is stable for a stationary sprite — the same x always gives the same offset", () => {
    // Guards against ever reintroducing a time term: a figure standing still must not twitch.
    expect(walkBobPx(true, 55)).toBe(walkBobPx(true, 55));
  });
});
