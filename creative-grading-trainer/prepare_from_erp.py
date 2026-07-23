"""Build a training set from ERP-persisted assets — the flywheel.

Every asset a designer saves in the Image Studio is stored by the persist endpoint
(platform-nest creative.controller) as original + graded + the grade JSON. This script
pulls those triples into data/before (original) and data/after (graded), and records the
stored grades in data/grades.jsonl for reference. Retrain on the growing set periodically
so the learned look tracks the team's real, evolving taste.

Auth mirrors the UI's dev BFF path: service token + x-user-id. Use a read-capable user.
"""
import argparse
import base64
import json
import os
import requests


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3004")
    ap.add_argument("--tenant", required=True)
    ap.add_argument("--token", required=True, help="PLATFORM_SERVICE_TOKEN")
    ap.add_argument("--user", required=True, help="x-user-id of a read-capable user")
    ap.add_argument("--out", default="data")
    ap.add_argument("--require-original", action="store_true", help="skip assets saved without an original")
    ap.add_argument("--training-only", action="store_true", help="only pull assets curated as training exemplars (training_ready=true)")
    args = ap.parse_args()

    h = {"authorization": f"Bearer {args.token}", "x-user-id": args.user}
    b_dir, a_dir = os.path.join(args.out, "before"), os.path.join(args.out, "after")
    os.makedirs(b_dir, exist_ok=True)
    os.makedirs(a_dir, exist_ok=True)

    list_url = f"{args.base}/api/{args.tenant}/creative/assets"
    if args.training_only:
        list_url += "?trainingReady=true"
    assets = requests.get(list_url, headers=h, timeout=30).json()
    print(f"[erp] {len(assets)} assets" + (" (training exemplars only)" if args.training_only else ""))

    kept = 0
    with open(os.path.join(args.out, "grades.jsonl"), "w", encoding="utf-8") as gout:
        for a in assets:
            aid = a["id"]
            orig = requests.get(f"{args.base}/api/{args.tenant}/creative/assets/{aid}/original", headers=h, timeout=60)
            if orig.status_code != 200:
                if args.require_original:
                    continue
                print(f"  [skip] {aid}: no original stored")
                continue
            graded = requests.get(f"{args.base}/api/{args.tenant}/creative/assets/{aid}/content", headers=h, timeout=60)
            if graded.status_code != 200:
                print(f"  [skip] {aid}: no graded content")
                continue
            with open(os.path.join(b_dir, f"{aid}.img"), "wb") as f:
                f.write(orig.content)
            with open(os.path.join(a_dir, f"{aid}.img"), "wb") as f:
                f.write(graded.content)
            gout.write(json.dumps({"id": aid, "grade": a.get("grade"), "preset": a.get("preset_id")}) + "\n")
            kept += 1

    print(f"[erp] wrote {kept} pairs into {args.out}/before + {args.out}/after (+ grades.jsonl)")
    print("[erp] note: rename extensions if your loader needs them; Pillow sniffs content regardless")


if __name__ == "__main__":
    main()
