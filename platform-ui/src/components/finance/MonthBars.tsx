// DW-7b-2: a small bar chart, one bar per month, for Finance's revenue by month. Server-renderable SVG, no state.
//
// A month that could not be read has `value: null` and is drawn as a hollow dashed stub on the baseline with the reason in its tooltip,
// never as a zero-height bar: an empty bar says "no revenue", and that is the claim a refused read must not make. The table beside the
// chart carries the same figures in words, so the chart is an aid and its `aria-label` says what it summarises.
export interface MonthBar { label: string; value: number | null; /** Said in the bar's tooltip when `value` is null. */ missing?: string; /** Said in the tooltip. */ text?: string }

const W = 600;
const H = 140;
const PAD = 6;
const GAP = 6;

export function MonthBars({ bars, caption }: { bars: readonly MonthBar[]; caption: string }) {
  if (bars.length === 0) return null;
  const values = bars.map((b) => b.value).filter((v): v is number => v !== null);
  const max = Math.max(0, ...values);
  const slot = (W - 2 * PAD) / bars.length;
  const barW = Math.max(2, slot - GAP);
  const base = H - PAD;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={caption}
      style={{ width: "100%", height: H, display: "block" }}
    >
      <line x1={PAD} x2={W - PAD} y1={base} y2={base} stroke="var(--ink-strong)" strokeWidth={0.6} strokeOpacity={0.25} />
      {bars.map((b, i) => {
        const x = PAD + i * slot + (slot - barW) / 2;
        if (b.value === null) {
          return (
            <rect key={b.label} x={x} y={base - 10} width={barW} height={10} fill="none" stroke="var(--ink-muted)" strokeWidth={1} strokeDasharray="3 2">
              <title>{`${b.label}: ${b.missing ?? "not read"}`}</title>
            </rect>
          );
        }
        // Revenue is drawn from the baseline up; a negative or zero month is a stub one pixel high, so it stays visible and is never mistaken for a gap.
        const h = max > 0 && b.value > 0 ? Math.max(1, (b.value / max) * (H - 2 * PAD)) : 1;
        return (
          <rect key={b.label} x={x} y={base - h} width={barW} height={h} fill="var(--erp-accent, var(--accent))" fillOpacity={0.85}>
            <title>{`${b.label}: ${b.text ?? b.value}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
