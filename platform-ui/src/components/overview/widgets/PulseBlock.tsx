import Link from "next/link";
import { pulseValueText, type PulseTileModel } from "@/lib/overviewPulse";

// DW-3e: the Overview's Pulse block. One tile per built reader: its label, a count and a link to the page that
// lists what it counts. A tile that could not be read says why in words ("No access", "Unavailable") in the
// figure's place; it is never an empty tile and never 0. A refused tile has no link, because its page would refuse too.
export function PulseBlock({ tiles }: { tiles: readonly PulseTileModel[] }) {
  return (
    <section className="ov-block ov-pulse" aria-label="Pulse">
      <h3 className="ov-block__title">Pulse</h3>
      <ul className="ov-pulse__tiles">
        {tiles.map((t) => {
          const body = (
            <>
              <span className="ov-nums__label">{t.label}</span>
              <span className={`ov-nums__value${t.reading.kind === "ok" ? "" : " ov-nums__value--none"}`}>{pulseValueText(t.reading)}</span>
              {t.reading.kind === "ok" && t.reading.detail && <span className="ov-nums__detail">{t.reading.detail}</span>}
            </>
          );
          return (
            <li key={t.key} className="ov-pulse__item" data-tile={t.key}>
              {t.href && t.reading.kind !== "forbidden"
                ? <Link href={t.href} className="ov-pulse__tile">{body}</Link>
                : <div className="ov-pulse__tile">{body}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
