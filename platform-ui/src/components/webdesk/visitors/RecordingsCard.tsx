import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { LIST_NOTE, NO_RECORDINGS_WORDS, fmtDuration, pagesLabel, type Recording } from "@/lib/replaysModel";
import { fmtWhen } from "@/lib/visitorsModel";
import "./visitors.css";

/** What the visitor page reads for the Recordings card. ABSENT (undefined) means the viewer lacks `search.replay.view`: no card, no read. */
export type RecordingsSectionData = { kind: "ok"; recordings: Recording[] } | { kind: "unavailable"; message: string };

// The visitor's recordings: when, how long, which pages, and a link to the player. Metadata only; nothing of the content is here.
// An unreadable list is words (never an empty table), and an empty one says the store answered and has none.
//
// The player is opened with a PLAIN link (a full page load), not next/link: the player page carries its own Content-Security-Policy
// (images only from the site's domains, lib/replaysCsp.ts), and a CSP belongs to the document it arrives with. A client-side
// navigation would play the recording inside this page's document and its weaker policy.
export function RecordingsCard({ section, playerBase }: { section: RecordingsSectionData; playerBase: string }) {
  if (section.kind === "unavailable") {
    return (
      <Card title="Recordings">
        <p className="wv-err" role="alert" data-testid="recordings-unavailable">{section.message}</p>
      </Card>
    );
  }
  const n = section.recordings.length;
  return (
    <Card title={`Recordings (${n})`}>
      <div data-testid="recordings">
        {n === 0 ? (
          <EmptyNote>{NO_RECORDINGS_WORDS}</EmptyNote>
        ) : (
          <table className="wv-table" data-testid="recordings-table">
            <thead><tr><th>When</th><th className="wv-num">Length</th><th>Pages</th><th><span className="wv-sr">Watch</span></th></tr></thead>
            <tbody>
              {/* Newest first, as the server sent them: never re-sorted. */}
              {section.recordings.map((r) => (
                <tr key={r.recordingId} data-testid="recording-row">
                  <td className="wv-nowrap">{fmtWhen(r.startedAt)}</td>
                  <td className="wv-num">{fmtDuration(r.durationSeconds)}</td>
                  <td>{pagesLabel(r.pages)}</td>
                  <td className="wv-nowrap">
                    <a href={`${playerBase}/${encodeURIComponent(r.recordingId)}`} className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="recording-watch">Watch</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="wv-note">{LIST_NOTE}</p>
      </div>
    </Card>
  );
}
