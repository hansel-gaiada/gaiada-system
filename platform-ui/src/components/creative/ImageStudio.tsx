"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IDENTITY_GRADE, bakeLut, renderToCanvas, canvasToWebp, webglAvailable,
  analyseImage, deriveAutoGrade, PRESETS, type Grade, type ImageStats,
} from "@/lib/imaging";
import { BeforeAfterSlider } from "./BeforeAfterSlider";
import { GradeSliders } from "./GradeSliders";
import { saveCreativeAsset } from "@/lib/creativeActions";
import "./creative.css";

interface Item { id: string; url: string; name: string }

// Blob → bare base64 (no data-URI prefix), for the JSON persist body.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

let uid = 0;
const nextId = () => `img-${Date.now()}-${uid++}`;

// Image Studio — the creative team's auto-correction & grading surface. Drag in a
// batch, pick a look (preset / one-click Auto) or grade by hand, compare
// before/after, then export optimised WebP. All processing is client-side (the
// engine bakes each look into a 3D LUT and applies it on the GPU); the ERP only
// ever receives the finished asset. The manual sliders and the preset/Auto looks
// edit the SAME Grade, so AI-and-manual are one workflow, not two.
export function ImageStudio({ deptId }: { deptId?: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [grades, setGrades] = useState<Record<string, Grade>>({});
  const [activePreset, setActivePreset] = useState<string>("neutral");
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const statsCache = useRef<Map<string, ImageStats>>(new Map());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const gpu = useRef<boolean>(true);

  // Create the persistent graded-output canvas once (client only).
  useEffect(() => {
    canvasRef.current = document.createElement("canvas");
    gpu.current = webglAvailable();
    setCanvasReady(true);
  }, []);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const grade = (selectedId && grades[selectedId]) || IDENTITY_GRADE;
  const gradeKey = Object.values(grade).join(",");

  const loadImage = useCallback((item: Item): Promise<HTMLImageElement> => {
    const cached = imgCache.current.get(item.id);
    if (cached?.complete) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => { imgCache.current.set(item.id, im); resolve(im); };
      im.onerror = reject;
      im.src = item.url;
    });
  }, []);

  // Render the selected image through the current grade whenever either changes.
  useEffect(() => {
    if (!canvasReady || !selected || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      const img = await loadImage(selected);
      if (cancelled || !canvasRef.current) return;
      try {
        renderToCanvas(img, bakeLut(grade), canvasRef.current);
      } catch {
        gpu.current = false; // GPU path failed; renderToCanvas already fell back to CPU on next call
      }
    })();
    return () => { cancelled = true; };
  }, [canvasReady, selected, gradeKey, loadImage, grade]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (incoming.length === 0) return;
    const newItems = incoming.map((f) => ({ id: nextId(), url: URL.createObjectURL(f), name: f.name }));
    setItems((prev) => [...prev, ...newItems]);
    setGrades((prev) => { const next = { ...prev }; for (const it of newItems) next[it.id] = IDENTITY_GRADE; return next; });
    setSelectedId((cur) => cur ?? newItems[0].id);
  }, []);

  const setField = useCallback((key: keyof Grade, value: number) => {
    if (!selectedId) return;
    setActivePreset("custom");
    setGrades((prev) => ({ ...prev, [selectedId]: { ...(prev[selectedId] ?? IDENTITY_GRADE), [key]: value } }));
  }, [selectedId]);

  const applyPreset = useCallback((id: string) => {
    if (!selectedId) return;
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setActivePreset(id);
    setGrades((prev) => ({ ...prev, [selectedId]: { ...preset.grade } }));
  }, [selectedId]);

  const autoEnhance = useCallback(async () => {
    if (!selected) return;
    const img = await loadImage(selected);
    let stats = statsCache.current.get(selected.id);
    if (!stats) {
      const c = document.createElement("canvas");
      const w = Math.min(256, img.naturalWidth || 256);
      const scale = w / (img.naturalWidth || w);
      c.width = w; c.height = Math.max(1, Math.round((img.naturalHeight || w) * scale));
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      stats = analyseImage(ctx.getImageData(0, 0, c.width, c.height).data, 1);
      statsCache.current.set(selected.id, stats);
    }
    setActivePreset("auto");
    setGrades((prev) => ({ ...prev, [selected.id]: deriveAutoGrade(stats!) }));
  }, [selected, loadImage]);

  const applyToAll = useCallback(() => {
    if (!selectedId) return;
    setGrades((prev) => {
      const g = prev[selectedId] ?? IDENTITY_GRADE;
      const next = { ...prev };
      for (const it of items) next[it.id] = { ...g };
      return next;
    });
  }, [selectedId, items]);

  const exportSelected = useCallback(async () => {
    if (!selected || !canvasRef.current) return;
    setBusy(true);
    try {
      const img = await loadImage(selected);
      renderToCanvas(img, bakeLut(grades[selected.id] ?? IDENTITY_GRADE), canvasRef.current);
      const blob = await canvasToWebp(canvasRef.current, 0.88);
      // Integration seam: to store in the ERP, POST `blob` + the grade JSON to the
      // creative-assets BFF endpoint (original + params kept for reproducibility).
      // Until that endpoint exists, we hand the optimised file back to the user.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = selected.name.replace(/\.[^.]+$/, "") + ".webp";
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setBusy(false);
    }
  }, [selected, grades, loadImage]);

  // Persist to the ERP: the graded result + the ORIGINAL + the exact grade params, so the
  // correction is reproducible/reversible (and becomes an AI training pair, phase 2).
  const saveToErp = useCallback(async () => {
    if (!selected || !canvasRef.current) return;
    setBusy(true); setSaveMsg(null);
    try {
      const g = grades[selected.id] ?? IDENTITY_GRADE;
      const img = await loadImage(selected);
      renderToCanvas(img, bakeLut(g), canvasRef.current);
      const gradedBlob = await canvasToWebp(canvasRef.current, 0.88);
      const originalBlob = await (await fetch(selected.url)).blob();
      const res = await saveCreativeAsset({
        name: selected.name.replace(/\.[^.]+$/, "") + ".webp",
        presetId: activePreset,
        width: canvasRef.current.width,
        height: canvasRef.current.height,
        grade: g as unknown as Record<string, number>,
        graded: await blobToBase64(gradedBlob),
        original: await blobToBase64(originalBlob),
        originalContentType: originalBlob.type || "image/jpeg",
        departmentId: deptId,
      });
      setSaveMsg(res.ok ? "Saved to ERP ✓" : res.error ?? "Save failed.");
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }, [selected, grades, activePreset, deptId, loadImage]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (items.length === 0) {
    return (
      <Dropzone dragOver={dragOver} setDragOver={setDragOver} onFiles={addFiles} large />
    );
  }

  return (
    <div className="cs">
      {/* Filmstrip */}
      <div className="cs-strip erp-scroll">
        {items.map((it) => (
          <button
            key={it.id}
            className={`cs-thumb${it.id === selectedId ? " is-active" : ""}`}
            onClick={() => setSelectedId(it.id)}
            title={it.name}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={it.url} alt={it.name} />
          </button>
        ))}
        <Dropzone dragOver={dragOver} setDragOver={setDragOver} onFiles={addFiles} />
      </div>

      <div className="cs-main">
        {/* Preview */}
        <div className="cs-preview">
          {selected && (
            <BeforeAfterSlider
              key={selected.id}
              originalUrl={selected.url}
              gradedCanvas={canvasReady ? canvasRef.current : null}
              alt={selected.name}
            />
          )}
          {!gpu.current && <p className="cs-note">Running on CPU (WebGL unavailable) — large images may render slowly.</p>}
        </div>

        {/* Controls */}
        <aside className="cs-panel">
          <div className="cs-section">
            <h4 className="cs-h">Looks</h4>
            <div className="cs-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`cs-chip${activePreset === p.id ? " is-active" : ""}`}
                  onClick={() => applyPreset(p.id)}
                  title={p.blurb}
                >
                  {p.label}
                </button>
              ))}
              <button className="cs-chip cs-chip--ai" disabled title="Trained on your before/after catalogue — phase 2">
                AI look · soon
              </button>
            </div>
            <div className="cs-actions">
              <button className="lux-btn lux-btn--ghost lux-btn--sm" onClick={autoEnhance}>Auto-enhance</button>
              <button className="lux-btn lux-btn--ghost lux-btn--sm" onClick={applyToAll} disabled={items.length < 2}>Apply to all ({items.length})</button>
            </div>
          </div>

          <div className="cs-section">
            <h4 className="cs-h">Manual grade</h4>
            <GradeSliders grade={grade} onChange={setField} />
          </div>

          <div className="cs-section">
            <div className="cs-actions">
              <button className="lux-btn lux-btn--solid lux-btn--md" onClick={saveToErp} disabled={busy}>
                {busy ? "Saving…" : "Save to ERP"}
              </button>
              <button className="lux-btn lux-btn--ghost lux-btn--md" onClick={exportSelected} disabled={busy}>
                Export WebP
              </button>
            </div>
            {saveMsg && <p className="cs-note" role="status">{saveMsg}</p>}
            <p className="cs-note">Grading is client-side. Save keeps the original + grade params for reproducibility.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Dropzone({ dragOver, setDragOver, onFiles, large }: {
  dragOver: boolean; setDragOver: (v: boolean) => void; onFiles: (f: FileList | File[]) => void; large?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`cs-drop${large ? " cs-drop--lg" : ""}${dragOver ? " is-over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
    >
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && onFiles(e.target.files)} />
      {large ? (
        <>
          <span className="cs-drop__glyph" aria-hidden="true">＋</span>
          <strong>Drop images to correct</strong>
          <span className="cs-note">or click to browse · batch supported · JPG / PNG / WebP</span>
        </>
      ) : (
        <span className="cs-drop__glyph" aria-hidden="true">＋</span>
      )}
    </div>
  );
}
