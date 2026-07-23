"use client";
import { useState, useTransition } from "react";
import { setAssetTraining } from "@/lib/creativeActions";
import type { CreativeAsset } from "@/lib/creative";

// The persisted-asset library + training curation. Shows every saved asset (original +
// graded + the grade recipe) and lets the team toggle whether each is a good exemplar for
// the phase-2 AI. The count of exemplars-with-originals is the trainer's dataset size —
// surfaced so "is there enough to train?" is answerable at a glance.
export function AssetLibrary({ assets }: { assets: CreativeAsset[] }) {
  if (assets.length === 0) {
    return (
      <p className="cs-note">
        No saved assets yet. Grade an image and hit <strong>Save to ERP</strong> — each save keeps the
        original + the exact grade, and becomes a training pair for the AI look.
      </p>
    );
  }
  const exemplars = assets.filter((a) => a.training_ready && a.has_original).length;
  return (
    <div className="cs-lib">
      <p className="cs-note" style={{ marginBottom: 4 }}>
        <strong>{exemplars}</strong> training exemplar{exemplars === 1 ? "" : "s"} (with originals) of {assets.length} saved.
        These feed <code>creative-grading-trainer</code> via <code>prepare_from_erp --training-only</code>.
      </p>
      <div className="cs-lib__grid">
        {assets.map((a) => (
          <AssetCard key={a.id} asset={a} />
        ))}
      </div>
    </div>
  );
}

function AssetCard({ asset }: { asset: CreativeAsset }) {
  const [ready, setReady] = useState(asset.training_ready);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const dims = asset.width && asset.height ? `${asset.width}×${asset.height}` : "";

  const toggle = () => {
    const next = !ready;
    setReady(next);
    setErr(null);
    start(async () => {
      const r = await setAssetTraining(asset.id, next);
      if (!r.ok) { setReady(!next); setErr(r.error ?? "Failed"); }
    });
  };

  return (
    <div className={`cs-lib__card${ready ? " is-training" : ""}`}>
      <div className="cs-lib__meta">
        <span className="cs-lib__name" title={asset.name}>{asset.name}</span>
        <span className="cs-lib__sub">
          {asset.preset_id ?? "custom"}{dims ? ` · ${dims}` : ""}{asset.has_original ? "" : " · no original"}
        </span>
      </div>
      <label className="cs-lib__toggle" title={asset.has_original ? "Use as a training exemplar" : "No original stored — can't train on this"}>
        <input type="checkbox" checked={ready} disabled={pending || !asset.has_original} onChange={toggle} />
        <span>Training</span>
      </label>
      {err && <span className="cs-lib__err">{err}</span>}
    </div>
  );
}
