import "./charts.css";

// The accessible twin every chart in the kit carries (dataviz interaction.md
// check 6 + anti-patterns "no table view / color-only encoding"): a real
// <table> with the SAME numbers as the plot, always mounted (not a
// details/summary the reader has to open — that removes it from the a11y
// tree until clicked) but visually hidden via the standard sr-only clip
// technique, so sighted users see the chart once and screen-reader users
// still reach every value without an extra action. Labels are untrusted
// data (interaction.md) — React's text-child rendering already avoids the
// innerHTML pitfall, so no extra escaping is needed here.
export interface ChartDataFallbackProps {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
}

export function ChartDataFallback({ caption, columns, rows }: ChartDataFallbackProps) {
  return (
    <table className="rc-fallback">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
