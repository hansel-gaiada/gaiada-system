"use client";
import { useCallback, useRef, useState } from "react";

// Interactive split slider — original underneath, graded canvas on top, revealed
// left-to-right by a draggable handle. Both layers share the source aspect ratio
// so they register pixel-for-pixel. Pointer + keyboard accessible.
export function BeforeAfterSlider({
  originalUrl,
  gradedCanvas,
  alt,
}: {
  originalUrl: string;
  /** The graded result canvas (rendered by the engine). Displayed as the top layer. */
  gradedCanvas: HTMLCanvasElement | null;
  alt: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50); // percent revealed of the graded (right) side
  const [dragging, setDragging] = useState(false);

  const setFromClientX = useCallback((clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const p = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(100, Math.max(0, p)));
  }, []);

  return (
    <div
      ref={wrapRef}
      className="cs-ba"
      onPointerDown={(e) => { setDragging(true); setFromClientX(e.clientX); (e.target as Element).setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => { if (dragging) setFromClientX(e.clientX); }}
      onPointerUp={() => setDragging(false)}
      role="group"
      aria-label="Before and after comparison"
    >
      {/* Original (before) — full width underneath */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={originalUrl} alt={alt} className="cs-ba__img" draggable={false} />

      {/* Graded (after) — clipped to the right of the handle */}
      <div className="cs-ba__after" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        {gradedCanvas && <GradedLayer canvas={gradedCanvas} />}
      </div>

      {/* Labels */}
      <span className="cs-ba__tag cs-ba__tag--l">Before</span>
      <span className="cs-ba__tag cs-ba__tag--r">After</span>

      {/* Handle */}
      <div className="cs-ba__handle" style={{ left: `${pos}%` }} aria-hidden="true">
        <span className="cs-ba__grip">⇄</span>
      </div>

      {/* Keyboard control */}
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        className="cs-ba__range"
        aria-label="Reveal amount"
      />
    </div>
  );
}

// Mounts a live canvas element into the DOM (the engine renders into it directly).
function GradedLayer({ canvas }: { canvas: HTMLCanvasElement }) {
  const host = useCallback((node: HTMLDivElement | null) => {
    if (node && canvas.parentElement !== node) {
      canvas.className = "cs-ba__img";
      node.appendChild(canvas);
    }
  }, [canvas]);
  return <div ref={host} style={{ width: "100%", height: "100%" }} />;
}
