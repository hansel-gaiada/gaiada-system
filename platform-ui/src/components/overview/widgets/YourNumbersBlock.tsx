import Link from "next/link";
import type { YourNumbers } from "@/lib/overviewNumbers";
import { DeltaChip } from "@/components/reports/charts/DeltaChip";

// DW-3d: the Overview's "Your numbers" block. Four tiles from the person's report. A figure the report did not
// state reads "No data", and a period that starts before the records do says so in words (never a quiet partial
// year). The change against the previous period reuses the report's own chip, so good and bad are coloured by
// the one rule; the compared range is named once, in the block's line, not on every tile.
export function YourNumbersBlock({ model, reportHref }: { model: YourNumbers; reportHref: string }) {
  return (
    <section className="ov-block ov-nums" aria-label="Your numbers">
      <h3 className="ov-block__title">Your numbers</h3>
      <p className="ov-block__note">{[model.periodLabel, model.comparison].filter(Boolean).join(" · ")}</p>

      <ul className="ov-nums__tiles">
        {model.tiles.map((t) => (
          <li key={t.key} className="ov-nums__tile">
            <span className="ov-nums__label">{t.label}</span>
            <span className={`ov-nums__value${t.noData ? " ov-nums__value--none" : ""}`}>{t.value}</span>
            {t.detail && <span className="ov-nums__detail">{t.detail}</span>}
            {t.delta && <DeltaChip delta={t.delta.change} direction={t.delta.direction} unit="count" magnitude={t.delta.magnitude} />}
          </li>
        ))}
      </ul>

      {model.note && <p className="ov-block__note" role="note">{model.note}</p>}

      <Link href={reportHref} className="ov-nums__link">Open my report</Link>
    </section>
  );
}
