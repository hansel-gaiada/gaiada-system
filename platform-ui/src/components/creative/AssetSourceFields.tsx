"use client";
// SCP-1h (BFF §63.6.6, §35.2): the two fields the Asset Library save gains: where the picture came from, and, for an AI-made one, how.
// Controlled, so the save form owns the value and runs `assetSourceProblem` before it sends. Left at "Not sure" a save sends nothing extra
// (the server's default is the same), and the post's design check then warns that the source is unknown.
import { useId } from "react";
import { AI_NOTE_HINT, AI_NOTE_MAX, ASSET_SOURCES, ASSET_SOURCE_LABEL, isAssetSource, type AssetSourceValue } from "@/lib/creativeSource";
import "./creative.css";

export function AssetSourceFields({ value, onChange, disabled = false }: { value: AssetSourceValue; onChange: (v: AssetSourceValue) => void; disabled?: boolean }) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="cs-source">
      <label className="lux-field__label" htmlFor={`${id}-source`}>Source</label>
      <select
        id={`${id}-source`}
        className="lux-field__control"
        value={value.source}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, source: isAssetSource(e.target.value) ? e.target.value : "unknown" })}
      >
        {ASSET_SOURCES.map((s) => <option key={s} value={s}>{ASSET_SOURCE_LABEL[s]}</option>)}
      </select>
      {value.source === "ai" && (
        <>
          <label className="lux-field__label" htmlFor={noteId}>AI note (required)</label>
          <textarea
            id={noteId}
            className="lux-field__control lux-field__control--textarea"
            value={value.aiNote}
            maxLength={AI_NOTE_MAX}
            disabled={disabled}
            aria-describedby={`${noteId}-hint`}
            onChange={(e) => onChange({ ...value, aiNote: e.target.value })}
          />
          <p id={`${noteId}-hint`} className="cs-note">{AI_NOTE_HINT}</p>
        </>
      )}
    </div>
  );
}
