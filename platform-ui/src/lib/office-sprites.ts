// The Office — LPC sprite asset contract (pure data + deterministic pickers, client-safe).
// Real pixel-art sprites now back human and internal-agent avatars; see
// components/office/OfficeCanvas.tsx's drawAvatar() for where these are actually composited and
// drawn. Every path this module points at is one of the 24 files verified against `CREDITS.csv`
// and recorded in `../../legal/asset-licences.md` — do not add a variant here without adding it to
// that verification AND to scripts/generate-office-credits.mjs's own file list. There are only 24,
// on purpose (owner decision, asset-licences.md: "keep the set small — this is an internal office
// tool, not a character-creator product"); the two lists are kept in sync by hand rather than one
// importing the other, because the script runs under plain Node (no bundler, no TS), so it carries
// its own literal copy — see that script's header for the same warning from the other side.
//
// Source: https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator
// Skin-tone ramps below are colour DATA read from that repo's own
// palette_definitions/body/body_ulpc.json (an OGA-BY/CC0-electable file, per the manifest) — not
// new art, just the six hex values LPC itself uses to recolour its "light" source art into each
// named tone. "steel" is not an LPC skin tone; it reuses that same file's neutral "fur_grey" ramp so
// internal agents recolour through the identical mechanism and land on an unmistakably synthetic
// grey rather than any human tone (plan §4.4: "reads as a colleague — but never as a person").

import { hashId } from "./office";

export type SpriteGender = "male" | "female";
export type SpritePose = "sit" | "walk";
export type SkinTone = "light" | "amber" | "olive" | "taupe" | "bronze" | "brown" | "black";

/** Native LPC frame size. Sprites are drawn at exactly this size (integer 1x scale) — see
 *  OfficeCanvas.tsx's drawAvatar() for why that particular integer was chosen over 2x/3x. */
export const FRAME_PX = 64;

/** Which cell to crop from each 9-col x 4-row (walk) / 3-col x 4-row (sit) sheet. LPC row order is
 *  0 = facing away (up), 1 = left, 2 = facing the viewer (down), 3 = right.
 *
 *  `sit` faces AWAY, because the desk is drawn above the seat tile: a seated avatar on row 2 had
 *  its back to its own monitor and stared out of the screen instead. Both poses used to be pinned
 *  to row 2 on the reasoning that avatars never turn, which was true of the direction but wrong
 *  about which direction a person at a desk should be facing.
 *
 *  `walk` stays on row 2. Transit is along the horizontal corridor, so neither up nor down is
 *  "correct"; facing the viewer keeps the person readable during the few seconds a replay has them
 *  in the corridor, which is exactly when someone is trying to see who is moving. */
export const POSE_FRAME: Record<SpritePose, { col: number; row: number }> = {
  sit: { col: 2, row: 0 },
  walk: { col: 0, row: 2 },
};

interface LayerSet {
  body: string;
  head: string;
  bottom: string;
  top: string;
  shoes: string;
  hair: string;
}

/** The 12 verified variant folders, one full outfit per gender — exactly the paths enumerated in
 *  legal/asset-licences.md. Composited back-to-front per plan §4.4a's layer model: body, head,
 *  bottom (so a shirt overlaps the waistband), top, shoes, hair (last, over the collar). */
export const LAYER_PATHS: Record<SpriteGender, LayerSet> = {
  male: {
    body: "body/bodies/male",
    head: "head/heads/human/male",
    bottom: "legs/formal/male",
    top: "torso/clothes/longsleeve/longsleeve/male",
    shoes: "feet/shoes/basic/male",
    hair: "hair/buzzcut/adult",
  },
  female: {
    body: "body/bodies/female",
    head: "head/heads/human/female",
    bottom: "legs/formal/thin",
    top: "torso/clothes/longsleeve/longsleeve/female",
    shoes: "feet/shoes/basic/thin",
    hair: "hair/bob/adult",
  },
};

/** The layer draw order, back to front — shared by every gender. */
export const LAYER_ORDER: Array<{ key: keyof LayerSet; recolorable: boolean }> = [
  { key: "body", recolorable: true },
  { key: "head", recolorable: true },
  { key: "bottom", recolorable: false },
  { key: "top", recolorable: false },
  { key: "shoes", recolorable: false },
  { key: "hair", recolorable: false },
];

export function spriteAssetPath(variantPath: string, pose: SpritePose): string {
  return `/office-sprites/${variantPath}/${pose}.png`;
}

// ── Skin-tone recolouring ────────────────────────────────────────────────────────────────────
// Every shipped body/head PNG is drawn in exactly this 6-colour ramp — verified by reading the
// pixels: these are the only 6 opaque colours in body/bodies/*/walk.png, and the same 6 (plus
// separately-drawn, never-touched eye colours) are the only skin-ramp colours in
// head/heads/human/*/walk.png. Recolouring is an exact-value swap, index for index.
export const LIGHT_RAMP: string[] = ["#271920", "#99423C", "#CC8665", "#E4A47C", "#F9D5BA", "#FAECE7"];

export const SKIN_RAMPS: Record<SkinTone, string[]> = {
  light: LIGHT_RAMP,
  amber: ["#281716", "#9E3E37", "#D28144", "#EA9F54", "#FDD082", "#FBE7A4"],
  olive: ["#271920", "#442725", "#7F4C31", "#AE6B3F", "#D38B59", "#E4A47C"],
  taupe: ["#271920", "#503734", "#785946", "#936849", "#BA8454", "#C7935F"],
  bronze: ["#1A1213", "#442725", "#644133", "#7F4C31", "#AE6B3F", "#D38B59"],
  brown: ["#120E10", "#412B29", "#5F4539", "#76513A", "#9C663E", "#B8773F"],
  black: ["#000000", "#1A1213", "#2E1F1C", "#442725", "#603429", "#7F4C31"],
};

/** Internal agents: same sprites, one fixed grey ramp — never a skin tone, never varying by id. */
export const STEEL_RAMP: string[] = ["#0F0F11", "#36363F", "#55585F", "#6A6E74", "#909699", "#B8BBBC"];

const SKIN_TONE_ORDER: SkinTone[] = ["light", "amber", "olive", "taupe", "bronze", "brown", "black"];

/** Deterministic, id-keyed — the same person always renders with the same gendered base and skin
 *  tone, with no lookup table and no per-person storage (mirrors office.ts's own catToken()). */
export function pickGender(id: string): SpriteGender {
  return hashId(`${id}:gender`) % 2 === 0 ? "male" : "female";
}

export function pickSkinTone(id: string): SkinTone {
  return SKIN_TONE_ORDER[hashId(`${id}:tone`) % SKIN_TONE_ORDER.length];
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
