# AI grade model drop-in

Place `grade-net.onnx` here (exported by `../../../creative-grading-trainer/export_onnx.py`)
to enable the Image Studio's **AI look** chip. Also `npm i onnxruntime-web`.

With neither present, the chip stays disabled ("AI look · soon") and nothing else changes —
the feature is runtime-detected (see `src/lib/imaging/aiLook.ts`), so the default build
carries no extra dependency and no model weight.
