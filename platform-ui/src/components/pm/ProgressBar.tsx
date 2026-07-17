import "./pm.css";

// Pure progress bar (0-100). Server-safe.
export function ProgressBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="pm-progress" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <span className="pm-progress__track"><span className="pm-progress__fill" style={{ right: `${100 - v}%` }} /></span>
      <span className="pm-progress__val">{v}%</span>
    </div>
  );
}
