# creative-grading-trainer

Phase-2 AI for the **Image Studio** (`platform-ui` creative department). Learns your
house colour-grade from **before/after image pairs** and exports a tiny model the
browser runs to propose a grade in one click — which the designer then fine-tunes on
the same sliders.

## Why this design (white-box, not black-box)

The model predicts the **nine Grade parameters** (exposure, contrast, temperature, tint,
gamma, saturation, vibrance, highlights, shadows) — *not* raw pixels and *not* an opaque
LUT. It is trained end-to-end: a small CNN looks at the *before* image, predicts a grade,
we apply a **differentiable copy of the exact `ops.ts` maths** (`grade_ops.py`) to the
before image, and minimise the difference to the *after* image.

Consequences that matter:
- **Interpretable / editable.** The output is nine numbers that land straight on the
  Studio sliders. The designer starts from the AI's proposal and nudges — AI and manual
  are one workflow, exactly the product requirement.
- **Tiny & fast.** Image → 9 floats. Runs in the browser via `onnxruntime-web` in a few
  ms; the existing engine bakes the 9 floats into a LUT and renders on the GPU. No change
  downstream — the LUT seam is unchanged from phase 1.
- **Honest ceiling.** This learns *your* look from *your* pairs. A fresh/off-the-shelf
  model aims at a stranger's taste (see the brainstorm). Expect ~one-click-to-80%, then a
  10-second manual finish — and it gets better as the pair set grows (the flywheel below).

## Pipeline

```
before/after pairs ──▶ data.py (load + curate)
                          │
                          ▼
                    train.py  ──uses──▶ grade_ops.py (differentiable ops = ops.ts)
                          │              model.py     (GradeNet: image → 9 params)
                          ▼
                    checkpoint.pt
                          │
                          ▼
                    export_onnx.py ──▶ grade-net.onnx
                          │
                          ▼
       platform-ui/public/models/grade-net.onnx  ──▶ lib/imaging/aiLook.ts (browser)
```

## Where it runs

- **Training: a GPU box, occasionally.** This is NOT runtime infrastructure — it's a job
  you run when you have new pairs. A single modest GPU (or a few-dollar rented RTX hour on
  vast.ai / RunPod) trains this in well under an hour. It will run on CPU too, just slower.
  **Do not train on the Intel Arc iGPU** (PyTorch-on-Arc is painful); train on CUDA/CPU.
- **Inference: the client browser**, via `onnxruntime-web` (WebGPU→WASM). Zero server
  cost, image never leaves the machine — same privacy story as the rest of the Studio.

## Quick start

```bash
python -m venv .venv && . .venv/Scripts/activate   # or .venv/bin/activate on *nix
pip install -r requirements.txt

# 1) Put curated pairs in data/before/<name>.jpg and data/after/<name>.jpg (same names),
#    OR pull them from the ERP from real designer edits (the flywheel). --training-only
#    fetches just the assets the team curated as exemplars (training_ready=true) in the
#    Studio's "Saved assets & training set" panel:
python prepare_from_erp.py --base http://localhost:3004 --tenant co-agency \
  --token "$PLATFORM_SERVICE_TOKEN" --user <userId> --out data \
  --training-only --require-original

# 2) Train
python train.py --data data --epochs 60 --out checkpoint.pt

# 3) Export for the browser
python export_onnx.py --ckpt checkpoint.pt --out grade-net.onnx
cp grade-net.onnx ../platform-ui/public/models/grade-net.onnx
```

Then in `platform-ui`, `npm i onnxruntime-web` and the Studio's **AI look** chip lights up
automatically (it feature-detects the model + runtime — absent either, it stays disabled,
and the lean build stays green).

## The flywheel

`prepare_from_erp.py` pulls `(original → graded, grade)` triples the persist endpoint
(`platform-nest` creative.controller, slice 1) stored from real designer work. Every asset
a designer saves becomes a training pair. Retrain periodically → the look tracks the team's
evolving taste. Gate/curate via the existing approvals surface before folding pairs in.

## Files

| File | Role |
|---|---|
| `grade_ops.py` | The 9 grade ops in PyTorch — a differentiable mirror of `platform-ui/src/lib/imaging/ops.ts`. Keep in sync. |
| `model.py` | `GradeNet` — small CNN, image → 9 params mapped into the Grade limits (init ≈ identity). |
| `data.py` | Pair dataset + curation (flags likely crop/retouch by aspect mismatch). |
| `train.py` | End-to-end training loop (L1 reconstruction of the after image). |
| `export_onnx.py` | Export the CNN to ONNX (image → 9 params), opset 17, dynamic batch. |
| `prepare_from_erp.py` | Build the training set from ERP-persisted assets (the flywheel). |
