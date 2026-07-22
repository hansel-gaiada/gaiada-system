// 3D LUT — the bridge between a Grade and the pixels.
//
// A grade is baked once into a NxNxN lookup table (N=33 is the .cube standard):
// for every point on a colour lattice we store where applyGrade() sends it. The
// WebGL renderer uploads this as a 3D texture and does a single trilinear lookup
// per pixel — so an arbitrarily complex grade costs the same as a trivial one,
// and a 4K image grades in milliseconds.
//
// This is ALSO the exact interface the phase-2 AI plugs into: a learned model
// (e.g. Image-Adaptive-3DLUT) predicts a LUT of this shape, and everything
// downstream — preview, batch, export — is unchanged. Deterministic presets and
// the learned look are interchangeable at this seam.

import type { Grade } from "./grade";
import { applyGrade, type RGB } from "./ops";

export interface Lut3D {
  /** Lattice size per axis (e.g. 33). */
  size: number;
  /** Flat RGB triples, length size^3 * 3, laid out with R fastest, then G, then B. */
  data: Float32Array;
}

export const DEFAULT_LUT_SIZE = 33;

/** Bake a Grade into a 3D LUT by evaluating applyGrade() over the colour lattice. */
export function bakeLut(grade: Grade, size: number = DEFAULT_LUT_SIZE): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  const denom = size - 1;
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    const b = bi / denom;
    for (let gi = 0; gi < size; gi++) {
      const g = gi / denom;
      for (let ri = 0; ri < size; ri++) {
        const r = ri / denom;
        const [or, og, ob] = applyGrade([r, g, b], grade);
        data[i++] = or;
        data[i++] = og;
        data[i++] = ob;
      }
    }
  }
  return { size, data };
}

/** Fetch a lattice node (no interpolation). Coordinates are integer indices. */
function node(lut: Lut3D, ri: number, gi: number, bi: number): RGB {
  const { size, data } = lut;
  const idx = (ri + gi * size + bi * size * size) * 3;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

/**
 * Trilinear sample of the LUT at a normalised [0,1] input colour. This is the CPU
 * mirror of the GPU's texture lookup — used for tests and for the Canvas2D
 * fallback path when WebGL is unavailable.
 */
export function sampleLut(lut: Lut3D, [r, g, b]: RGB): RGB {
  const { size } = lut;
  const max = size - 1;
  const cr = Math.min(Math.max(r, 0), 1) * max;
  const cg = Math.min(Math.max(g, 0), 1) * max;
  const cb = Math.min(Math.max(b, 0), 1) * max;

  const r0 = Math.floor(cr), g0 = Math.floor(cg), b0 = Math.floor(cb);
  const r1 = Math.min(r0 + 1, max), g1 = Math.min(g0 + 1, max), b1 = Math.min(b0 + 1, max);
  const fr = cr - r0, fg = cg - g0, fb = cb - b0;

  const lerp = (a: RGB, c: RGB, t: number): RGB => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];

  // Interpolate along R, then G, then B.
  const c000 = node(lut, r0, g0, b0), c100 = node(lut, r1, g0, b0);
  const c010 = node(lut, r0, g1, b0), c110 = node(lut, r1, g1, b0);
  const c001 = node(lut, r0, g0, b1), c101 = node(lut, r1, g0, b1);
  const c011 = node(lut, r0, g1, b1), c111 = node(lut, r1, g1, b1);

  const c00 = lerp(c000, c100, fr), c10 = lerp(c010, c110, fr);
  const c01 = lerp(c001, c101, fr), c11 = lerp(c011, c111, fr);
  const c0 = lerp(c00, c10, fg), c1 = lerp(c01, c11, fg);
  return lerp(c0, c1, fb);
}

/**
 * Pack a LUT into a WebGL-friendly 2D atlas (size×size tiles laid left-to-right,
 * each tile a size×size R/G slice for one B level) as 8-bit RGBA. Used by the
 * renderer for WebGL1/2 environments without 3D-texture support. Returns the
 * atlas pixels plus the tile layout the shader needs.
 */
export function lutToAtlas(lut: Lut3D): { width: number; height: number; pixels: Uint8Array; tilesPerRow: number } {
  const { size, data } = lut;
  const tilesPerRow = size; // one tile per blue slice, in a single row
  const width = size * tilesPerRow;
  const height = size;
  const pixels = new Uint8Array(width * height * 4);
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const src = (ri + gi * size + bi * size * size) * 3;
        const x = bi * size + ri;
        const y = gi;
        const dst = (y * width + x) * 4;
        pixels[dst] = Math.round(data[src] * 255);
        pixels[dst + 1] = Math.round(data[src + 1] * 255);
        pixels[dst + 2] = Math.round(data[src + 2] * 255);
        pixels[dst + 3] = 255;
      }
    }
  }
  return { width, height, pixels, tilesPerRow };
}

/**
 * Apply a LUT to a full RGBA pixel buffer on the CPU (Canvas2D fallback). Mutates
 * and returns the same buffer. Alpha is preserved. This is intentionally the
 * fallback — the GPU path is the default in the browser.
 */
export function applyLutToImageData(lut: Lut3D, rgba: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < rgba.length; i += 4) {
    const [or, og, ob] = sampleLut(lut, [rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255]);
    rgba[i] = or * 255;
    rgba[i + 1] = og * 255;
    rgba[i + 2] = ob * 255;
    // alpha (i+3) untouched
  }
  return rgba;
}
