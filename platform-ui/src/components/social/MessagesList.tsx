"use client";
// SCP-1j — the Social Messages page's list (BFF §63.7 `GET waiting`, §63.14 `follow_up`): the officer's posts that someone else holds, grouped by who
// holds them, each with its step, how long it has waited and when the holder was last reminded, and a Follow up button.
//
// Follow up posts `follow_up` on the post (`expectedStatus` the step the person is looking at, a fresh `actionId`, an optional note). The server decides:
// a second follow-up inside 24 hours is 409 `follow_up_too_soon` with `retryAfterSeconds`, which the row shows as a wait and counts in words; a post nobody
// else holds is 409 `nobody_to_follow_up`. The button never decides anything: it asks, and says what the server answered.
//
// A client-held post also links to the client's conversation (PV-4), and every post opens at `{D}/posts/[postId]` (the post page is SCP-1e's).
import { useState, useTransition } from "react";
import Link from "next/link";
import { followUpAction } from "@/lib/socialMessagesActions";
import {
  agoWords, clientConversationHref, holderTitle, postHref, statusWords, waitWords, type WaitingGroup, type WaitingPost,
} from "@/lib/socialMessages";

type RowState =
  | { kind: "idle" }
  | { kind: "done"; at: string }
  | { kind: "wait"; seconds: number; text: string }
  | { kind: "error"; text: string };

export function MessagesList({ groups, deptId, nowIso }: { groups: WaitingGroup[]; deptId: string; nowIso: string }) {
  const now = Date.parse(nowIso);
  return (
    <div className="scp-sections">
      {groups.map((g) => (
        <section key={g.holder.role} aria-labelledby={`scp-msg-${g.holder.role}`}>
          <h4 className="scp-section__title" id={`scp-msg-${g.holder.role}`}>
            {holderTitle(g.holder.role, g.holder.label)} <span className="scp-msg__count">({g.posts.length})</span>
          </h4>
          <ul className="scp-msglist">
            {g.posts.map((p) => (
              <MessageRow key={p.id} post={p} role={g.holder.role} deptId={deptId} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MessageRow({ post, role, deptId, now }: { post: WaitingPost; role: string; deptId: string; now: number }) {
  const [state, setState] = useState<RowState>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const lastIso = state.kind === "done" ? state.at : post.lastFollowUpAt;
  const waiting = state.kind === "wait";

  function followUp() {
    setState({ kind: "idle" });
    startTransition(async () => {
      const res = await followUpAction(post.id, post.pipelineStatus);
      if (res.ok) { setState({ kind: "done", at: new Date().toISOString() }); return; }
      if (res.error === "follow_up_too_soon" && res.retryAfterSeconds !== undefined) {
        setState({ kind: "wait", seconds: res.retryAfterSeconds, text: res.message });
        return;
      }
      setState({ kind: "error", text: res.message });
    });
  }

  return (
    <li className="scp-msglist__item">
      <div className="scp-msglist__main">
        <Link className="scp-msglist__title" href={postHref(deptId, post.id)}>{post.title}</Link>
        <span className="scp-table__sub">
          {post.clientName} · {statusWords(post.pipelineStatus)} · waiting {agoWords(post.since, now).replace(/ ago$/, "")}
        </span>
        <span className="scp-table__sub">
          {lastIso ? `Last follow-up ${state.kind === "done" ? "just now" : agoWords(lastIso, now)}` : "No follow-up yet"}
        </span>
      </div>
      <div className="scp-msglist__actions">
        {role === "client" && post.clientId !== "" && (
          <Link className="scp-link" href={clientConversationHref(post.clientId)}>Open the conversation</Link>
        )}
        <button type="button" className="scp-link" onClick={followUp} disabled={pending || waiting} aria-describedby={`scp-msg-status-${post.id}`}>
          {pending ? "Following up…" : waiting ? `Follow up in ${waitWords(state.seconds)}` : "Follow up"}
        </button>
      </div>
      <p
        id={`scp-msg-status-${post.id}`} role={state.kind === "error" ? "alert" : "status"}
        className={`scp-msg ${state.kind === "done" ? "scp-msg--ok" : state.kind === "error" ? "scp-msg--error" : ""} scp-msglist__status`}
      >
        {state.kind === "done" && "Followed up. The holder has been reminded."}
        {state.kind === "wait" && state.text}
        {state.kind === "error" && state.text}
      </p>
    </li>
  );
}
