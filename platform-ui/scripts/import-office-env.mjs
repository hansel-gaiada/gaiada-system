// Import the `Waha` Office environment pack (Creative, 2026-08-24) to engine scale.
//
// WHY A SCRIPT AND NOT A MANUAL COPY: the delivery is 128x128 per asset and the engine's tile is
// TILE_PX=16, so every file needs the SAME downscale factor or furniture stops agreeing with the
// floor it stands on. Recording the transform here means the next delivery re-runs it instead of
// somebody re-deriving the ratio by eye.
//
// SCALE, and why the delivered pack lands on our grid exactly:
//   delivered  characters 256 : tiles 128  = 2:1
//   our target characters  32 : tiles  16  = 2:1   -> one uniform /8 for characters, /8 for tiles.
// Floors are the exception: they are TEXTURES, tiled per-cell, so they go to a flat 16x16 and must
// stay seamless. Everything else is an OBJECT drawn over the floor and goes to 32x32 (= 2x2 tiles),
// which keeps a desk readable at zoom 1 instead of collapsing to a 14px smudge.
//
// SOURCE IS NOT IN THE REPO. The delivery lives outside version control; only the derived PNGs are
// committed. Pass the delivery root as argv[2].
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import sharp from "sharp";

const SRC = process.argv[2];
const OUT = new URL("../public/office-env/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
if (!SRC) {
  console.error("usage: node scripts/import-office-env.mjs <path-to-Waha/Office>");
  process.exit(1);
}

/** Floors tile per-cell so they match TILE_PX exactly; every other category is an object sprite. */
const TILE_PX = 16;
const OBJECT_PX = 32;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".png")) out.push(p);
  }
  return out;
}

const files = await walk(SRC);
let written = 0, skipped = 0;
for (const f of files) {
  const rel = relative(SRC, f).split(sep).join("/");
  const isFloor = rel.startsWith("floors/");
  const size = isFloor ? TILE_PX : OBJECT_PX;

  // A FULLY TRANSPARENT source is a delivery defect, not an asset. 369 of the character files are
  // blank; if any land in Office/ they must be reported, never silently written as an empty sprite
  // that renders as a hole in the room.
  const img = sharp(f).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  let maxA = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > maxA) maxA = data[i];
  if (maxA === 0) { console.warn(`  BLANK, skipped: ${rel}`); skipped++; continue; }

  const dest = join(OUT, rel);
  await mkdir(dest.slice(0, dest.lastIndexOf(sep)), { recursive: true });
  // `kernel: nearest` would alias this art badly — it is genuine 128px illustration, not an
  // upscaled low-res original (verified: uniform-block size is 1px), so there is no pixel grid to
  // preserve and lanczos keeps the shape legible at 32px.
  await writeFile(dest, await sharp(f).resize(size, size, { fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer());
  written++;
}
console.log(`office-env: ${written} written, ${skipped} skipped (blank), from ${files.length} source files`);
