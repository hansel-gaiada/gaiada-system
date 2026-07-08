export function LineChart({ series, height = 180 }: { series: number[]; height?: number }) {
  if (series.length < 2) return <svg style={{ width: "100%", height }} aria-hidden />;
  const w = 600, h = height, pad = 6;
  const max = Math.max(...series), min = Math.min(...series);
  const rng = max - min || 1, n = series.length;
  const xs = (i: number) => pad + i * ((w - 2 * pad) / (n - 1));
  const ys = (v: number) => h - pad - ((v - min) / rng) * (h - 2 * pad);
  const line = series.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`).join(" ");
  const area = `${line} L${xs(n - 1).toFixed(1)} ${h} L${xs(0).toFixed(1)} ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height, display: "block" }}>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={pad} x2={w - pad} y1={pad + g * (h - 2 * pad)} y2={pad + g * (h - 2 * pad)}
          stroke="#1A1916" strokeWidth={0.5} strokeOpacity={0.09} />
      ))}
      <path d={area} fill="var(--erp-accent, #6E5A43)" fillOpacity={0.09} />
      <path d={line} fill="none" stroke="var(--erp-accent, #6E5A43)" strokeWidth={1.6} />
      <circle cx={xs(n - 1)} cy={ys(series[n - 1])} r={3.2} fill="var(--erp-accent, #6E5A43)" />
    </svg>
  );
}
