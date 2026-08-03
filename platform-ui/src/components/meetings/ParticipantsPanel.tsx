"use client";
import { useActionState } from "react";
import { addParticipantAction, removeParticipantAction, type ParticipantResult } from "@/lib/schedulingActions";
import { SIDE_LABEL, type MeetingParticipant } from "@/lib/schedulingView";
import "@/components/departments/departments.css";

// W1 — who is in this meeting, on both sides (owner decision D-3: "all parties always trackable").
//
// The `side` chip is NOT an input. The API derives it from `client_contacts` and ignores any claim in
// the request body, so this panel reports a fact rather than offering a choice — showing a dropdown
// here would imply the UI has a say it does not have, and would invite someone to "fix" a label by
// mislabelling a person.
export function ParticipantsPanel({
  recordingId,
  clientId,
  participants,
  candidates,
}: {
  recordingId: string;
  clientId?: string | null;
  participants: MeetingParticipant[];
  /** Staff and client contacts who could attend. Resolved server-side; the split is cosmetic here
   *  because the API is the authority on which side someone lands on. */
  candidates: { userId: string; label: string; hint: string }[];
}) {
  const [added, addAction, addPending] = useActionState<ParticipantResult | null, FormData>(addParticipantAction, null);
  const [removed, removeAction, removePending] = useActionState<ParticipantResult | null, FormData>(removeParticipantAction, null);

  const present = new Set(participants.map((p) => p.user_id));
  const selectable = candidates.filter((c) => !present.has(c.userId));
  const clientCount = participants.filter((p) => p.side === "client").length;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
        Everyone attending, on both sides. Whether someone counts as the client is determined by their
        client-contact record, not chosen here.
      </p>

      {/* A client meeting with nobody from the client side is worth saying out loud during setup —
          it is the state that later reads as "why did nobody review this?". */}
      {clientId && participants.length > 0 && clientCount === 0 && (
        <p className="dept-teach" style={{ padding: "10px 12px", margin: 0, font: "400 12px/1.5 var(--font-body)" }}>
          Nobody from the client side is attending yet. Add a client contact, or invite one on the
          client&rsquo;s page first.
        </p>
      )}

      {participants.length === 0 ? (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
          No participants recorded yet.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {participants.map((p) => (
            <div
              key={p.user_id}
              style={{
                display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
                padding: "9px 12px", border: "1px solid var(--line)", borderRadius: 10,
              }}
            >
              <span style={{ flex: "1 1 180px", minWidth: 0 }}>
                <span style={{ font: "500 13px var(--font-body)", color: "var(--ink)" }}>{p.name || p.email || p.user_id}</span>
                {p.email && p.name && (
                  <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)", marginLeft: 8 }}>{p.email}</span>
                )}
              </span>
              <span
                style={{
                  font: "500 12px var(--font-body)",
                  color: p.side === "client" ? "var(--erp-accent)" : "var(--ink-muted)",
                }}
              >
                {SIDE_LABEL[p.side]}
              </span>
              <form action={removeAction}>
                <input type="hidden" name="recordingId" value={recordingId} />
                <input type="hidden" name="userId" value={p.user_id} />
                {clientId && <input type="hidden" name="clientId" value={clientId} />}
                <button type="submit" className="btn" disabled={removePending} style={{ fontSize: 12 }}>
                  {removePending ? "…" : "Remove"}
                </button>
              </form>
            </div>
          ))}
        </div>
      )}

      {selectable.length > 0 && (
        <form action={addAction} style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <input type="hidden" name="recordingId" value={recordingId} />
          {clientId && <input type="hidden" name="clientId" value={clientId} />}
          <label style={{ display: "grid", gap: 4, flex: "1 1 240px" }}>
            <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-muted)" }}>Add someone</span>
            <select
              name="userId"
              required
              defaultValue=""
              style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px var(--font-body)" }}
            >
              <option value="" disabled>
                Choose a person…
              </option>
              {selectable.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.label} — {c.hint}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn" disabled={addPending} style={{ fontSize: 13 }}>
            {addPending ? "Adding…" : "Add"}
          </button>
        </form>
      )}

      {added && !added.ok && added.error && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{added.error}</p>
      )}
      {removed && !removed.ok && removed.error && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }}>{removed.error}</p>
      )}
    </div>
  );
}
