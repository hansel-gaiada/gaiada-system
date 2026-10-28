"use client";
// SCP-3e (plan §8 row 3e, BFF §63.6.1) — "plan a post on a day": the small dialog behind a day's "+". The person chooses the client, gives the post a title (and a
// format if they know it), and the post is made through the client page's own create flow: `POST cycles/:cycleId/posts` (`createClientPost`, the body built by
// `buildNewPost`) in that client's cycle for the month on show, dated that day at the client's default post time, placed on the client's platforms. It starts
// `planned`; the date, time and networks stay editable on the post until it goes on (`editableFieldsOf`).
//
// Only the clients the viewer may create a post for are listed (`canCreate`: the client's officer, or one of the four approvers); the server still decides
// (403 `not_officer_or_approver`) and its refusal is shown in words. A client with no cycle for the month is listed and cannot be chosen, with the reason beside it.
import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { Modal } from "@/components/overlay/Modal";
import { createClientPost } from "@/lib/socialClientActions";
import { ALLOCATION_FORMATS, FORMAT_LABEL, NETWORK_LABEL } from "@/lib/socialAllocation";
import { buildNewPost, monthTitle, newUuid } from "@/lib/socialClient";
import { dayLabel } from "@/lib/deptCalendar";
import { defaultPostIso, timeOfIso, type PlanClient } from "@/lib/socialCalendar";

export interface Planned { postId: string; title: string; clientName: string; day: string }

export function CalendarPlan({
  deptId, day, month, clients: allClients, onClose, onDone,
}: {
  deptId: string; day: string; month: string; clients: readonly PlanClient[]; onClose: () => void; onDone: (p: Planned) => void;
}) {
  const uid = useId();
  const clients = allClients.filter((c) => c.canCreate);
  const usable = clients.filter((c) => c.cycleId !== null);
  const [engagementId, setEngagementId] = useState(usable[0]?.engagementId ?? "");
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("");
  const [postId] = useState(() => newUuid());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const client = clients.find((c) => c.engagementId === engagementId) ?? null;
  const at = client ? defaultPostIso(day, client.defaultPostTime) : "";

  function submit() {
    setError(null);
    if (!client || !client.cycleId) { setError("Choose a client that has a cycle this month."); return; }
    if (!at) { setError("That time does not exist on that day. Open the client's page to choose another."); return; }
    const built = buildNewPost({ title, format, pillar: "", scheduledLocal: "", placement: client.platforms, isExtra: false }, postId);
    if (!built.ok) { setError(built.message); return; }
    const cycleId = client.cycleId;
    start(async () => {
      const r = await createClientPost(cycleId, { ...built.body, scheduledAt: at });
      if (!r.ok) { setError(r.message); return; }
      onDone({ postId: r.postId, title: built.body.title, clientName: client.clientName, day });
    });
  }

  return (
    <Modal
      open onClose={onClose} title={`Plan a post on ${dayLabel(day)}`} size="md"
      footer={
        <>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submit} disabled={pending || usable.length === 0}>{pending ? "Adding…" : "Add to the plan"}</button>
        </>
      }
    >
      <div className="scp-dialog">
        {clients.length === 0 ? (
          <p className="scp-note" style={{ margin: 0 }}>No client is open in the Social Media allocation, so there is nobody to plan a post for.</p>
        ) : (
          <>
            <label className="scp-field" htmlFor={`${uid}-client`}>
              Client
              <select id={`${uid}-client`} className="scp-input" value={engagementId} onChange={(e) => setEngagementId(e.target.value)}>
                {clients.map((c) => (
                  <option key={c.engagementId} value={c.engagementId} disabled={c.cycleId === null}>
                    {c.clientName}{c.mine ? " (yours)" : ""}{c.cycleId === null ? ` — no cycle in ${monthTitle(month)}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {usable.length === 0 && (
              <p className="scp-note scp-note--reason" style={{ margin: 0 }}>
                No client has a cycle in {monthTitle(month)}, so a post cannot be added to it yet. A Social Media head opens a cycle by setting its deadline in Settings.
              </p>
            )}
            <label className="scp-field" htmlFor={`${uid}-title`}>
              Title
              <input id={`${uid}-title`} className="scp-input" value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="scp-field" htmlFor={`${uid}-format`}>
              Format
              <select id={`${uid}-format`} className="scp-input" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="">Not chosen yet</option>
                {ALLOCATION_FORMATS.map((x) => <option key={x} value={x}>{FORMAT_LABEL[x]}</option>)}
              </select>
            </label>
            {client && (
              <p className="scp-note" style={{ margin: 0 }}>
                {at
                  ? <>Dated <strong>{dayLabel(day)}</strong> at <strong>{timeOfIso(at)}</strong>, {client.defaultPostTime ? `${client.clientName}'s default post time` : "9:00, as the client has no default time"}.</>
                  : "That time does not exist on that day."}{" "}
                {client.platforms.length > 0
                  ? <>Placed on {client.platforms.map((n) => NETWORK_LABEL[n] ?? n).join(", ")}.</>
                  : "The client has no platforms yet, so the post has no placement until one is set."}{" "}
                The client approves the date, time and placement with the post.
              </p>
            )}
          </>
        )}
        {error && <p className="scp-msg scp-msg--error" role="alert">{error}</p>}
        <p className="scp-note" style={{ margin: 0 }}>
          Or open the client&apos;s page for the full form{client ? <>: <Link href={`/departments/${encodeURIComponent(deptId)}/profile/${encodeURIComponent(client.engagementId)}?new=post`}>New post for {client.clientName}</Link></> : ""}.
        </p>
      </div>
    </Modal>
  );
}
