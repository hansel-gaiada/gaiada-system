"use client";
import { GRADE_LIMITS, type Grade } from "@/lib/imaging";

// The manual control panel — one slider per Grade field. Fully controlled: it
// renders the current grade and calls back with the edited field. This is the
// "human does it too" half; presets and Auto write into the very same Grade, so
// a designer can start from an AI/preset look and fine-tune from there.

interface Row { key: keyof Grade; label: string; hint?: string }

const ROWS: Row[] = [
  { key: "exposure", label: "Exposure", hint: "stops" },
  { key: "contrast", label: "Contrast" },
  { key: "temperature", label: "Temperature", hint: "cool ↔ warm" },
  { key: "tint", label: "Tint", hint: "green ↔ magenta" },
  { key: "highlights", label: "Highlights" },
  { key: "shadows", label: "Shadows" },
  { key: "gamma", label: "Gamma", hint: "midtones" },
  { key: "saturation", label: "Saturation" },
  { key: "vibrance", label: "Vibrance" },
];

export function GradeSliders({ grade, onChange }: { grade: Grade; onChange: (key: keyof Grade, value: number) => void }) {
  return (
    <div className="cs-sliders">
      {ROWS.map((row) => {
        const lim = GRADE_LIMITS[row.key];
        const val = grade[row.key];
        return (
          <label key={row.key} className="cs-slider">
            <span className="cs-slider__head">
              <span className="cs-slider__label">{row.label}{row.hint && <em> · {row.hint}</em>}</span>
              <span className="cs-slider__val">{val.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={lim.min}
              max={lim.max}
              step={lim.step}
              value={val}
              onChange={(e) => onChange(row.key, Number(e.target.value))}
            />
          </label>
        );
      })}
    </div>
  );
}
