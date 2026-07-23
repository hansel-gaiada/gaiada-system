"""End-to-end training: CNN predicts a grade, we apply the differentiable ops to the
BEFORE image, and minimise L1 to the AFTER image. No per-pixel labels and no pre-fitted
grade labels are needed — the reconstruction loss supervises the 9 parameters directly.
This is the white-box `exposure`-style objective, specialised to one house look."""
import argparse
import torch
from torch.utils.data import DataLoader
from data import PairDataset
from model import GradeNet
from grade_ops import apply_grade, PARAM_NAMES


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--out", default="checkpoint.pt")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[train] device={device}")

    ds = PairDataset(args.data, size=args.size)
    dl = DataLoader(ds, batch_size=args.batch, shuffle=True, num_workers=0, drop_last=False)

    net = GradeNet().to(device)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr)
    l1 = torch.nn.L1Loss()

    for epoch in range(1, args.epochs + 1):
        net.train()
        total, n = 0.0, 0
        for before, after in dl:
            before, after = before.to(device), after.to(device)
            params = net(before)
            graded = apply_grade(before, params)
            loss = l1(graded, after)
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item() * before.size(0); n += before.size(0)
        if epoch % 5 == 0 or epoch == 1:
            with torch.no_grad():
                mean_p = net(next(iter(dl))[0].to(device)).mean(0).cpu()
            recipe = ", ".join(f"{k}={v:.2f}" for k, v in zip(PARAM_NAMES, mean_p.tolist()))
            print(f"[train] epoch {epoch:3d}  L1={total / n:.4f}  mean grade: {recipe}")

    torch.save({"model": net.state_dict(), "params": PARAM_NAMES, "size": args.size}, args.out)
    print(f"[train] saved {args.out}")


if __name__ == "__main__":
    main()
