import type { CSSProperties, ReactNode } from "react";
import "./feedback.css";

export function Skeleton({ width, height = 14, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <span className="fb-skeleton" style={{ display: "block", width: width ?? "100%", height, ...style }} aria-hidden="true" />;
}

// A generic page skeleton (header + card grid) used by route loading.tsx files.
export function PageSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="fb-skeleton-page" role="status" aria-label="Loading">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Skeleton width={90} height={10} />
        <Skeleton width={280} height={30} />
        <Skeleton width={420} height={14} />
      </div>
      <div className="fb-skeleton-cards">
        {Array.from({ length: cards }).map((_, i) => (
          <div className="fb-skeleton-card" key={i}>
            <Skeleton width={120} height={10} />
            <Skeleton width="70%" height={26} />
            <Skeleton width="100%" height={12} />
            <Skeleton width="55%" height={12} />
          </div>
        ))}
      </div>
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Loading…</span>
    </div>
  );
}

// Shared shell for error / not-found pages.
export function StateScreen({ code, title, body, actions }: { code?: string; title: string; body: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fb-state" role="alert">
      {code && <div className="fb-state__code">{code}</div>}
      <h1 className="fb-state__title">{title}</h1>
      <p className="fb-state__body">{body}</p>
      {actions && <div className="fb-state__actions">{actions}</div>}
    </div>
  );
}
