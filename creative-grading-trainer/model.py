"""GradeNet — a small CNN that maps a (downsampled) image to the 9 Grade parameters.

Deliberately tiny: the whole point is a fast, interpretable predictor whose output is the
same 9 numbers the Studio sliders use. The final layer emits raw logits which are squashed
into each parameter's allowed range (GRADE_LIMITS, mirrored from grade.ts), with the bias
initialised so an untrained net predicts ~identity (no-op) — a stable starting point.
"""
import torch
import torch.nn as nn
from grade_ops import PARAM_NAMES

# (min, max, identity) per parameter — mirrors GRADE_LIMITS + IDENTITY_GRADE in grade.ts.
LIMITS = {
    "exposure": (-3.0, 3.0, 0.0),
    "contrast": (0.0, 2.0, 1.0),
    "temperature": (-1.0, 1.0, 0.0),
    "tint": (-1.0, 1.0, 0.0),
    "gamma": (0.3, 3.0, 1.0),
    "saturation": (0.0, 2.0, 1.0),
    "vibrance": (-1.0, 1.0, 0.0),
    "highlights": (-1.0, 1.0, 0.0),
    "shadows": (-1.0, 1.0, 0.0),
}
_MIN = torch.tensor([LIMITS[n][0] for n in PARAM_NAMES])
_MAX = torch.tensor([LIMITS[n][1] for n in PARAM_NAMES])
_ID = torch.tensor([LIMITS[n][2] for n in PARAM_NAMES])


def _conv(cin, cout):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, stride=2, padding=1), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class GradeNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            _conv(3, 16), _conv(16, 32), _conv(32, 64), _conv(64, 128),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Linear(128, len(PARAM_NAMES))
        # Init so sigmoid(head)≈ identity position within [min,max].
        with torch.no_grad():
            frac = (_ID - _MIN) / (_MAX - _MIN)            # identity as a 0..1 fraction
            self.head.bias.copy_(torch.log(frac / (1 - frac)))  # inverse-sigmoid (logit)
            self.head.weight.mul_(0.01)                    # start near-flat

    def forward(self, x):
        z = self.features(x).flatten(1)
        frac = torch.sigmoid(self.head(z))                 # [B,9] in (0,1)
        lo, hi = _MIN.to(x.device), _MAX.to(x.device)
        return lo + frac * (hi - lo)                       # map into Grade ranges
