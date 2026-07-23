"""Differentiable grade operations — a PyTorch mirror of platform-ui/src/lib/imaging/ops.ts.

Operates on image tensors [B, 3, H, W] in [0, 1] (sRGB/gamma space) and a params tensor
[B, 9] whose columns carry the SAME semantics/units as the TypeScript Grade struct. The
op sequence and every formula match ops.ts exactly, so a grade fit here reproduces
pixel-for-pixel when the browser applies the same 9 numbers. KEEP IN SYNC with ops.ts.
"""
import torch

# Column order of the params tensor — must match GRADE_KEYS in the browser + model.py.
PARAM_NAMES = ["exposure", "contrast", "temperature", "tint", "gamma", "saturation", "vibrance", "highlights", "shadows"]
IDX = {name: i for i, name in enumerate(PARAM_NAMES)}

# Luma weights (Rec.709), identical to ops.ts.
_LW = torch.tensor([0.2126, 0.7152, 0.0722]).view(1, 3, 1, 1)


def _luma(img):
    return (img * _LW.to(img.device)).sum(dim=1, keepdim=True)


def apply_grade(img, p):
    """img: [B,3,H,W] in [0,1]; p: [B,9] in Grade units. Returns graded image in [0,1]."""
    b = p.shape[0]
    g = lambda name: p[:, IDX[name]].view(b, 1, 1, 1)

    # 1) White balance — rGain=1+0.25*temp, bGain=1-0.25*temp, gGain=1-0.15*tint.
    temp, tint = g("temperature"), g("tint")
    gains = torch.cat([1 + 0.25 * temp, 1 - 0.15 * tint, 1 - 0.25 * temp], dim=1)  # [B,3,1,1]
    img = torch.clamp(img * gains, 0.0, 1.0)

    # 2) Exposure — * 2^ev.
    img = torch.clamp(img * torch.pow(2.0, g("exposure")), 0.0, 1.0)

    # 3) Contrast about 0.5.
    img = torch.clamp((img - 0.5) * g("contrast") + 0.5, 0.0, 1.0)

    # 4) Tone regions — shadowW=(1-L)^2, highlightW=L^2.
    L = _luma(img)
    delta = g("shadows") * 0.5 * (1 - L) ** 2 + g("highlights") * 0.5 * L ** 2
    img = torch.clamp(img + delta, 0.0, 1.0)

    # 5) Gamma — c^(1/gamma). Clamp floor keeps the gradient finite at 0.
    img = torch.pow(torch.clamp(img, 1e-6, 1.0), 1.0 / g("gamma"))

    # 6) Saturation about luma.
    L = _luma(img)
    img = torch.clamp(L + (img - L) * g("saturation"), 0.0, 1.0)

    # 7) Vibrance — boost weighted by (1 - HSV saturation).
    mx = img.max(dim=1, keepdim=True).values
    mn = img.min(dim=1, keepdim=True).values
    sat = torch.where(mx > 0, (mx - mn) / torch.clamp(mx, 1e-6), torch.zeros_like(mx))
    boost = 1 + g("vibrance") * (1 - sat)
    L = _luma(img)
    img = torch.clamp(L + (img - L) * boost, 0.0, 1.0)

    return img
