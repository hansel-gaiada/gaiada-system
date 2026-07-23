"""Export the trained GradeNet to ONNX: input a [B,3,size,size] image in [0,1], output a
[B,9] grade tensor (columns = PARAM_NAMES). The browser (lib/imaging/aiLook.ts) runs this
with onnxruntime-web, then feeds the 9 numbers into the existing bakeLut → render path."""
import argparse
import torch
from model import GradeNet
from grade_ops import PARAM_NAMES


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="checkpoint.pt")
    ap.add_argument("--out", default="grade-net.onnx")
    args = ap.parse_args()

    ckpt = torch.load(args.ckpt, map_location="cpu")
    size = ckpt.get("size", 256)
    net = GradeNet()
    net.load_state_dict(ckpt["model"])
    net.eval()

    dummy = torch.rand(1, 3, size, size)
    torch.onnx.export(
        net, dummy, args.out,
        input_names=["image"], output_names=["grade"],
        dynamic_axes={"image": {0: "batch"}, "grade": {0: "batch"}},
        opset_version=17,
    )
    print(f"[export] wrote {args.out}  (input image[1,3,{size},{size}] in [0,1] → grade[1,9])")
    print(f"[export] grade columns: {PARAM_NAMES}")
    print(f"[export] copy to platform-ui/public/models/grade-net.onnx to enable the AI look chip")


if __name__ == "__main__":
    main()
