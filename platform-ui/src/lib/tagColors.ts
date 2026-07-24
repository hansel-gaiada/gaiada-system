// Shared, client-safe tag-color constants (P2-02, design spec §6). Deliberately
// NOT "server-only" — components/pm/TagChip.tsx and ColorSwatchPicker.tsx are
// client components and need these as real values (not just types), unlike
// everything else in lib/pm.ts (which imports the `TagColor` TYPE from here —
// type-only imports are erased at compile time, so that doesn't reintroduce a
// server-only leak). A closed 8-slug palette extending the existing accent
// family (STATUS_COLORS in components/ui.tsx; --primitive-bronze/
// --primitive-champagne in styles/tokens/colors.css) at the same muted
// desaturation.
//
// Each tone ships TWO hex values — `onLight` (text/border color used on the
// system's normal `--surface-card` paper background, #FBFAF6) and `onDark`
// (used under `.lux-card--dark`, background #1A1916) — because a single fixed
// color CANNOT pass WCAG AA (4.5:1 normal text) against both a near-white and
// a near-black surface at once: the required luminance bands (<=~0.17 for the
// light card, >=~0.22 for the dark card, via the WCAG contrast formula) don't
// overlap. Verified 2026-07-24 with a standalone relative-luminance/contrast
// script (WCAG 2.1 formula, exact hex pairs below) — every value clears
// 4.5:1 with real margin on its intended surface (6.78:1 lowest, most land
// 7.4-11.6:1):
//
//   bronze     onLight #5C4A36 vs #FBFAF6 = 8.08:1   onDark #C9AE8C vs #1A1916 = 8.30:1
//   champagne  onLight #5E5138 vs #FBFAF6 = 7.42:1   onDark #D8C7A1 vs #1A1916 = 10.55:1
//   olive      onLight #565C2E vs #FBFAF6 = 6.78:1   onDark #C4CB92 vs #1A1916 = 10.30:1
//   slate      onLight #3F4A56 vs #FBFAF6 = 8.65:1   onDark #AEBEC9 vs #1A1916 = 9.22:1
//   clay       onLight #6B3F2C vs #FBFAF6 = 8.47:1   onDark #D5A386 vs #1A1916 = 7.88:1
//   moss       onLight #33513A vs #FBFAF6 = 8.45:1   onDark #A8C4AC vs #1A1916 = 9.34:1
//   dust       onLight #5E4640 vs #FBFAF6 = 8.29:1   onDark #D2B3AA vs #1A1916 = 9.01:1
//   ink        onLight #33363C vs #FBFAF6 = 11.60:1  onDark #B7BCC4 vs #1A1916 = 9.21:1
//
// `onDark` doubles as the TOGGLED-ON tag-picker chip fill (paired with ink
// #1A1916 text — 7.9-10.5:1, see the same table) precisely so that state
// reads correctly regardless of which surface the picker itself sits on: it's
// an opaque fill, not text-on-card, so it never depends on light/dark card
// context at all.
export type TagColor = "bronze" | "champagne" | "olive" | "slate" | "clay" | "moss" | "dust" | "ink";

export const TAG_COLORS: TagColor[] = ["bronze", "champagne", "olive", "slate", "clay", "moss", "dust", "ink"];

export const TAG_COLOR_LABEL: Record<TagColor, string> = {
  bronze: "Bronze", champagne: "Champagne", olive: "Olive", slate: "Slate",
  clay: "Clay", moss: "Moss", dust: "Dust", ink: "Ink",
};

export const TAG_COLOR_HEX: Record<TagColor, { onLight: string; onDark: string }> = {
  bronze:    { onLight: "#5C4A36", onDark: "#C9AE8C" },
  champagne: { onLight: "#5E5138", onDark: "#D8C7A1" },
  olive:     { onLight: "#565C2E", onDark: "#C4CB92" },
  slate:     { onLight: "#3F4A56", onDark: "#AEBEC9" },
  clay:      { onLight: "#6B3F2C", onDark: "#D5A386" },
  moss:      { onLight: "#33513A", onDark: "#A8C4AC" },
  dust:      { onLight: "#5E4640", onDark: "#D2B3AA" },
  ink:       { onLight: "#33363C", onDark: "#B7BCC4" },
};

export function isTagColor(v: string): v is TagColor {
  return (TAG_COLORS as string[]).includes(v);
}

// ---- custom-status color bridge (P2-05, design spec §7) ----
// ProjectStatus.color is a free-form hex string (the four synth defaults carry
// the exact legacy Gantt hues for pixel parity). The status editor still reuses
// the shared 8-swatch ColorSwatchPicker (TagColor slugs), so these two helpers
// bridge slug<->hex. A status picked from the palette stores its `onLight` hex
// (dark enough to carry the bar's light text, matching the legacy mid-tone
// fills); a legacy default hex simply doesn't reverse-map (the picker then shows
// its fallback swatch until the user changes it — cosmetic only).
export function statusHexForColor(c: TagColor): string {
  return TAG_COLOR_HEX[c].onLight;
}
export function tagColorFromHex(hex: string): TagColor | undefined {
  return TAG_COLORS.find((c) => TAG_COLOR_HEX[c].onLight.toLowerCase() === hex.toLowerCase());
}
