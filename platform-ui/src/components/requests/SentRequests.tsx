import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card } from "@/components/ui";
import { sentScopeCopy, type MergedSent } from "@/lib/requests";
import { RequestsTable } from "./RequestsTable";
import "./requests.css";

// DW-10e (BFF §60.9): the sent list of My requests and of a department's Sent tab. It merges §32's read with the sender read, and it is
// honest about both halves:
//  - the scope the sender read answered (DW-D40, DW-D43): "Requests you sent" when only the caller's are shown (`own`), "Requests from
//    the departments you lead" for a head (`unit`), "Requests <company> sent" when the caller is a manager or administrator and sees
//    everything the company sent (`company`);
//  - a part that could not be read is said out loud, beside what WAS read. A list that left one half out never reads as the whole, and an
//    empty list is claimed only when both halves answered.
export function SentRequests({
  merged, company, empty, showRequester, titleOverride, hintOverride,
}: {
  merged: MergedSent;
  /** The active company's name, for the scope wording. */
  company: string | null;
  /** What to say when both reads answered and there is nothing. */
  empty: string;
  showRequester: boolean;
  /** A department's Sent tab keeps its own words; the scope note still applies. */
  titleOverride?: string;
  hintOverride?: string;
}) {
  const copy = sentScopeCopy(merged.scope, company);
  const showNote = copy.note && merged.acrossCount > 0;
  return (
    <Card title={titleOverride ?? copy.title} hint={hintOverride ?? copy.hint}>
      {merged.failed.map((f) => (
        <ReadRefusal
          key={f.part} inline kind={f.kind} reason={f.reason}
          subject={f.part === "companies" ? "The requests you sent to other companies" : "The requests you sent to other departments"}
          detail={merged.rows.length > 0 ? "What is listed below is the other part only." : undefined}
        />
      ))}
      {showNote ? <p className="req-note" style={{ marginBottom: 10 }}>{copy.note}</p> : null}
      {merged.rows.length > 0
        ? <RequestsTable rows={merged.rows} showRequester={showRequester} />
        : merged.failed.length === 0 ? <p className="req-empty">{empty}</p> : null}
    </Card>
  );
}
