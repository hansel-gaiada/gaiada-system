// SCP-1e (BFF §63.6.2) — the post's copy edit log (each change to a copy field, before and after, with who made it, who suggested it and the step it was made at) and its
// activity (the `history` the server reads from the post's activity rows, newest last; it never shows a note's text). Both are plain lists.
import { formatDateTime } from "@/lib/format";
import { FIELD_LABEL, historyLine, logValue, statusLabel, type PipelinePost } from "@/lib/socialPipeline";

export function CopyLog({ post }: { post: PipelinePost }) {
  if (post.copyLog.length === 0) return <p className="scp-note" style={{ margin: 0 }}>No copy has been changed since it was first written.</p>;
  return (
    <ul className="scp-log" aria-label="Copy edit log">
      {post.copyLog.map((c, i) => (
        <li key={i}>
          <strong>{FIELD_LABEL[c.field] ?? c.field}</strong>{" "}
          {c.via === "suggestion" ? `by ${c.by?.name ?? "someone"}, suggested by ${c.suggestedBy?.name ?? "the copywriter"}` : `fixed by ${c.by?.name ?? "someone"}`}
          {c.stage ? ` at ${statusLabel(c.stage)}` : ""} <span className="scp-log__when">{formatDateTime(c.at)}</span>
          <span className="scp-log__diff"><span className="scp-log__old">{logValue(c.before)}</span> to {logValue(c.after)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Activity({ post }: { post: PipelinePost }) {
  if (post.history.length === 0) return <p className="scp-note" style={{ margin: 0 }}>No activity yet.</p>;
  return (
    <ol className="scp-log" aria-label="Activity">
      {post.history.map((h, i) => {
        const l = historyLine(h);
        return (
          <li key={i}>
            {l.who} {l.what}{l.move ? ` (${l.move})` : ""} <span className="scp-log__when">{formatDateTime(h.at)}</span>
          </li>
        );
      })}
    </ol>
  );
}
