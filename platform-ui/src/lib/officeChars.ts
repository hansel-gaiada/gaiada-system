// Purpose-drawn 32x32 avatars for the two principals that DO NOT WALK.
//
// Agents and automations sit at desks. That is the whole reason this pack is usable today while
// the human roster is not: Creative's delivery has one frame and one direction per character, and
// a figure that never leaves its desk needs exactly one frame and one direction. Humans stay on
// the LPC sheets deliberately — those carry real `walk` and `sit` poses, and swapping them for a
// single-frame sprite would trade a working walk cycle for correct scale. That trade only becomes
// worth making when the four directions arrive.
//
// See legal/asset-licences.md for provenance: AI-generated, no third-party licence, no attribution
// obligation — and no copyright of our own either, which is why nothing here may become brand art.

/** Native frame size of every sprite in this pack. Verified at import: the importer asserts it. */
export const CHAR_PX = 32;

/** Drawn at 2x (64px = 2 tiles at TILE_PX*ZOOM), matching the LPC humans beside them. NOT 1x.
 *  1x would be one tile — the right size for the smaller-character world decision — but that
 *  decision is not implemented yet, so a 1x android next to a 2x human would just read as a
 *  scale bug. Integer factor only, so the pixel grid survives. When the world does shrink, this
 *  becomes 1 and the humans move with it. */
export const CHAR_DRAW_SCALE = 2;

/** The fixed synthetic look agents were specified to have. Four variants, not one: the office runs
 *  several agents at once and four identical androids at four desks reads as a rendering fault
 *  rather than as four agents. Never varies by anything but id — an agent's avatar is not a
 *  setting, and it must never drift between renders. */
export const AGENT_SPRITES: readonly string[] = [
  "/office-chars/agents/ai-guardian-android.png",
  "/office-chars/agents/ai-explorer-android.png",
  "/office-chars/agents/ai-scientist-android.png",
  "/office-chars/agents/ai-assassin-android.png",
];

/** Twelve automation variants — the owner's reason for the cats and dogs: "so we have more
 *  variants for the amount of automation workers that we have". Cats and dogs are pooled into one
 *  list on purpose; the split is a folder convention in the delivery, not a distinction that means
 *  anything about the automation. */
export const AUTOMATION_SPRITES: readonly string[] = [
  "/office-chars/automations/cats/black-cyber-cat.png",
  "/office-chars/automations/dogs/cyber-husky.png",
  "/office-chars/automations/cats/golden-ai-cat.png",
  "/office-chars/automations/dogs/cyber-shiba.png",
  "/office-chars/automations/cats/neon-blue-cyber-cat.png",
  "/office-chars/automations/dogs/cyber-guardian-dog.png",
  "/office-chars/automations/cats/silver-robot-cat.png",
  "/office-chars/automations/dogs/cyber-security-dog.png",
  "/office-chars/automations/cats/white-cyber-cat.png",
  "/office-chars/automations/dogs/cyber-rescue-dog.png",
  "/office-chars/automations/cats/fantasy-cyber-cat.png",
  "/office-chars/automations/dogs/fantasy-ai-dog.png",
];

/** Deterministic pick from a list. Shared by both so the two can never drift into different
 *  hashing rules — the same id must land on the same sprite on every render, on every machine,
 *  forever, or an avatar changes identity when the page reloads. */
function pick(list: readonly string[], id: string, hash: (s: string) => number): string {
  return list[hash(id) % list.length];
}

export function agentSpritePath(id: string, hash: (s: string) => number): string {
  return pick(AGENT_SPRITES, id, hash);
}

export function automationSpritePath(id: string, hash: (s: string) => number): string {
  return pick(AUTOMATION_SPRITES, id, hash);
}

/** The procedural half of "animation" — see docs: Creative's pack has no animation frames, and the
 *  motion that matters here (a figure working at a desk) does not need any. One frame plus a 1px
 *  vertical offset on the existing pulse beat is a two-frame animation, which is how pixel art has
 *  always done this. It is honest, too: the offset is driven by the SAME `pulseOn` that already
 *  gates the working glow, so a desk can never bob while claiming to be idle.
 *
 *  Returns device pixels to subtract from the sprite's y. Zero unless the principal is actually
 *  active — a still avatar is the default, and stillness is a claim we can always support. */
export function activeBobPx(isActive: boolean, pulseOn: boolean): number {
  return isActive && pulseOn ? CHAR_DRAW_SCALE : 0;
}

/** The walk cycle for a sprite that has no walk frames.
 *
 *  Agents move now (office-data.ts derives agent handoffs), and their pack ships ONE frame — so a
 *  walking android would otherwise glide across the floor like a chess piece. This bobs it.
 *
 *  Driven by the sprite's x POSITION, not by elapsed time, and that is the whole trick: a real walk
 *  cycle advances per step taken, so tying the bob to distance covered makes a figure crossing a
 *  long corridor take more steps than one shuffling to the next desk, automatically, with no speed
 *  parameter to keep in sync. A time-based bob would have a sprite paddling on the spot whenever
 *  the path was short.
 *
 *  `STRIDE_PX` is in device pixels: one bob per stride of travel. */
const STRIDE_PX = 10;

export function walkBobPx(inTransit: boolean, xPx: number): number {
  if (!inTransit) return 0;
  return Math.floor(Math.abs(xPx) / STRIDE_PX) % 2 === 0 ? 0 : CHAR_DRAW_SCALE;
}
