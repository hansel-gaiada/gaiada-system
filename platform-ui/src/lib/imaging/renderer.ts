// Renderer — applies a baked LUT to an image and produces the corrected bitmap.
// Browser-only (uses canvas / WebGL). Two paths, transparent to the caller:
//   • GPU (default): WebGL2 fragment shader does a trilinear LUT lookup per pixel.
//     A 4K image grades in a few ms regardless of how complex the grade is.
//   • CPU fallback: Canvas2D + sampleLut, for environments without WebGL2.
// The maths is identical to lut.ts, so both paths agree.
//
// Kept out of the pure engine files so those stay testable under jsdom (no GPU).

import { applyLutToImageData, lutToAtlas, type Lut3D } from "./lut";

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Fragment shader: sample the source, then look the colour up in the LUT atlas
// (size tiles across; blue selects the tile, red/green index within it).
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uLut;
uniform float uSize;   // lattice size (e.g. 33)
uniform bool uFlip;
out vec4 fragColor;

vec2 tileUv(float r, float g, float bIndex) {
  float maxI = uSize - 1.0;
  float atlasW = uSize * uSize;
  // half-texel inset keeps bilinear filtering from bleeding across blue tiles.
  float x = (bIndex * uSize) + clamp(r * maxI, 0.5, uSize - 0.5);
  float y = clamp(g * maxI, 0.5, uSize - 0.5);
  return vec2(x / atlasW, y / uSize);
}

vec3 lutLookup(vec3 c) {
  float maxI = uSize - 1.0;
  float bPos = clamp(c.b, 0.0, 1.0) * maxI;
  float b0 = floor(bPos);
  float b1 = min(b0 + 1.0, maxI);
  float fb = bPos - b0;
  vec3 s0 = texture(uLut, tileUv(c.r, c.g, b0)).rgb;
  vec3 s1 = texture(uLut, tileUv(c.r, c.g, b1)).rgb;
  return mix(s0, s1, fb);
}

void main() {
  vec2 uv = uFlip ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
  vec4 src = texture(uSrc, uv);
  fragColor = vec4(lutLookup(src.rgb), src.a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader compile failed: " + log);
  }
  return sh;
}

/** True when this environment can run the GPU path. */
export function webglAvailable(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * Render `source` graded by `lut` into `target`, sized to the source. Uses WebGL2
 * when available, otherwise a CPU fallback. `flipY` compensates for WebGL's
 * bottom-left origin when the source is a DOM image/canvas.
 */
export function renderToCanvas(
  source: CanvasImageSource & { width: number; height: number },
  lut: Lut3D,
  target: AnyCanvas,
): void {
  const w = (source as { naturalWidth?: number }).naturalWidth || source.width;
  const h = (source as { naturalHeight?: number }).naturalHeight || source.height;
  target.width = w;
  target.height = h;

  const gl = (target as HTMLCanvasElement).getContext("webgl2") as WebGL2RenderingContext | null;
  if (!gl) {
    renderCpu(source, lut, target as HTMLCanvasElement, w, h);
    return;
  }

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("program link failed: " + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  // Full-screen quad.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  // Source texture (unit 0).
  const srcTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as unknown as TexImageSource);

  // LUT atlas texture (unit 1).
  const atlas = lutToAtlas(lut);
  const lutTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlas.width, atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas.pixels);

  gl.uniform1i(gl.getUniformLocation(prog, "uSrc"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "uLut"), 1);
  gl.uniform1f(gl.getUniformLocation(prog, "uSize"), lut.size);
  gl.uniform1i(gl.getUniformLocation(prog, "uFlip"), 1);

  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function renderCpu(source: CanvasImageSource, lut: Lut3D, target: HTMLCanvasElement, w: number, h: number): void {
  const ctx = target.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  applyLutToImageData(lut, img.data);
  ctx.putImageData(img, 0, 0);
}

/** Encode a canvas to a compressed WebP blob (falls back to PNG if WebP unsupported). */
export function canvasToWebp(canvas: HTMLCanvasElement, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      "image/webp",
      quality,
    );
  });
}
