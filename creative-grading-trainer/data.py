"""Pair dataset + curation.

Expects data/before/<name>.<ext> and data/after/<name>.<ext> with matching stems. The
CURATION step is the part that decides quality (see the brainstorm): a pair must differ
by TONE/COLOUR only. We can't fully detect a retouch, but a large aspect-ratio mismatch is
a strong signal the 'after' was cropped/reframed — those pairs are dropped with a warning,
because they'd teach the model spatial changes it can't (and shouldn't) reproduce.
"""
import os
from PIL import Image
import torch
from torch.utils.data import Dataset
import torchvision.transforms.functional as TF

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def _stem_map(d):
    out = {}
    if not os.path.isdir(d):
        return out
    for f in os.listdir(d):
        stem, ext = os.path.splitext(f)
        if ext.lower() in IMG_EXTS:
            out[stem] = os.path.join(d, f)
    return out


def find_pairs(root, aspect_tol=0.06):
    """Return [(before_path, after_path)] for matching stems that pass curation."""
    before, after = _stem_map(os.path.join(root, "before")), _stem_map(os.path.join(root, "after"))
    pairs, dropped = [], 0
    for stem in sorted(set(before) & set(after)):
        bp, ap = before[stem], after[stem]
        with Image.open(bp) as bi, Image.open(ap) as ai:
            ba, aa = bi.width / bi.height, ai.width / ai.height
        if abs(ba - aa) / max(ba, aa) > aspect_tol:
            print(f"  [curate] drop '{stem}': aspect {ba:.3f} vs {aa:.3f} (likely cropped/reframed)")
            dropped += 1
            continue
        pairs.append((bp, ap))
    print(f"[data] {len(pairs)} usable pairs ({dropped} dropped by curation)")
    return pairs


class PairDataset(Dataset):
    def __init__(self, root, size=256):
        self.pairs = find_pairs(root)
        if not self.pairs:
            raise SystemExit(f"No usable pairs under {root}/before + {root}/after")
        self.size = size

    def __len__(self):
        return len(self.pairs)

    def _load(self, path):
        img = Image.open(path).convert("RGB").resize((self.size, self.size), Image.BILINEAR)
        return TF.to_tensor(img)  # [3,H,W] in [0,1]

    def __getitem__(self, i):
        bp, ap = self.pairs[i]
        return self._load(bp), self._load(ap)
