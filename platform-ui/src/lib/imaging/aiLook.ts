// Phase-2 AI look — browser inference. Loads the learned grade model (trained by
// ../../creative-grading-trainer) with onnxruntime-web and predicts the 9 Grade params
// from the image. The output is an ordinary Grade, so it flows through the exact same
// bakeLut → render path as presets and manual edits (the LUT seam), and lands on the
// sliders for the designer to fine-tune.
//
// FEATURE-DETECTED, ZERO-DEPENDENCY BY DEFAULT: onnxruntime-web is imported dynamically
// via a non-literal specifier and the model is fetched at runtime — so the lean build
// stays green with neither present. If either is missing, aiLookAvailable() resolves
// false and the Studio's "AI look" chip stays disabled. Install onnxruntime-web and drop
// grade-net.onnx into public/models/ to switch it on.

import { clampGrade, IDENTITY_GRADE, type Grade } from "./grade";

const MODEL_URL = "/models/grade-net.onnx";
const SIZE = 256; // must match the trainer's --size
// Column order of the model's [1,9] output — must match grade_ops.PARAM_NAMES.
const PARAM_ORDER: (keyof Grade)[] = ["exposure", "contrast", "temperature", "tint", "gamma", "saturation", "vibrance", "highlights", "shadows"];

// `any` on purpose: onnxruntime-web is an optional, runtime-only dependency, so we must
// not reference its types at compile time (it may not be installed).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtModule = any;
let ortPromise: Promise<OrtModule | null> | null = null;
let sessionPromise: Promise<unknown | null> | null = null;

async function loadRuntime(): Promise<OrtModule | null> {
  if (!ortPromise) {
    // Non-literal specifier: keeps this out of static bundling/type resolution so the
    // build doesn't require the package to be installed.
    const spec = "onnxruntime-web";
    ortPromise = import(/* webpackIgnore: true */ spec).then((m) => m as OrtModule).catch(() => null);
  }
  return ortPromise;
}

async function getSession(): Promise<unknown | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const ort = await loadRuntime();
        if (!ort) return null;
        const res = await fetch(MODEL_URL, { method: "GET" });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        return await ort.InferenceSession.create(buf, { executionProviders: ["webgpu", "wasm"] });
      } catch {
        return null;
      }
    })();
  }
  return sessionPromise;
}

/** True when both the runtime and a model are present — the AI look chip gates on this. */
export async function aiLookAvailable(): Promise<boolean> {
  return (await getSession()) !== null;
}

/** Preprocess an image into a normalised NCHW Float32Array [1,3,SIZE,SIZE]. */
function toTensorData(src: CanvasImageSource): Float32Array {
  const c = document.createElement("canvas");
  c.width = SIZE; c.height = SIZE;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(src, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = data[i] / 255;              // R
    out[plane + p] = data[i + 1] / 255;  // G
    out[2 * plane + p] = data[i + 2] / 255; // B
  }
  return out;
}

/** Run the model on an image and return the predicted Grade (or null if AI isn't available). */
export async function predictGrade(src: CanvasImageSource): Promise<Grade | null> {
  const session = await getSession();
  const ort = await loadRuntime();
  if (!session || !ort) return null;
  try {
    const input = new ort.Tensor("float32", toTensorData(src), [1, 3, SIZE, SIZE]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = session as any;
    const feeds: Record<string, unknown> = { [s.inputNames[0]]: input };
    const output = await s.run(feeds);
    const arr = output[s.outputNames[0]].data as Float32Array;
    const grade: Grade = { ...IDENTITY_GRADE };
    PARAM_ORDER.forEach((k, i) => { grade[k] = arr[i]; });
    return clampGrade(grade);
  } catch {
    return null;
  }
}
