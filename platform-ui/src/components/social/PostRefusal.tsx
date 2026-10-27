// SCP-1e — a refusal of a write, in words: the sentence for the code (with the figures the server added) and, for a 409 with `blockers`, one line per failed check.
// Every write on the post page shows its refusal through this, beside the control that made it, so a refusal is never a silent failure and never a bare code.
import { blockerLines, type Refusal } from "@/lib/socialPipeline";

export function RefusalNote({ refusal, message }: { refusal: Refusal; message: string }) {
  const lines = blockerLines(refusal);
  return (
    <div className="scp-msg scp-msg--error" role="alert">
      <p style={{ margin: 0 }}>{message}</p>
      {lines.length > 0 && (
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
    </div>
  );
}
