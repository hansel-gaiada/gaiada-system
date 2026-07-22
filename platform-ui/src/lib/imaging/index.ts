// Image Studio grading engine — public surface.
//
// Layers (bottom to top):
//   grade.ts       — the Grade struct: the serialisable description of a look.
//   ops.ts         — pure per-pixel colour maths (the source of truth).
//   lut.ts         — bake a Grade → 3D LUT; the seam where AI-predicted looks plug in.
//   presets.ts     — hand-authored looks (Vivid Warm, Product Clean, …).
//   autoEnhance.ts — deterministic neutral correction (the "Auto" button).
//   renderer.ts    — apply a LUT to pixels on GPU (WebGL2) or CPU fallback; WebP export.

export * from "./grade";
export * from "./ops";
export * from "./lut";
export * from "./presets";
export * from "./autoEnhance";
export * from "./renderer";
