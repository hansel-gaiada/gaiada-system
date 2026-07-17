"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Comment } from "@/lib/pm";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "./pm.css";

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

interface Props {
  comments: Comment[];
  post: (body: string) => Promise<{ ok: boolean; error?: string }>;
}

export function CommentThread({ comments, post }: Props) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const v = body.trim();
    if (!v) return;
    setBody("");
    startTransition(async () => { await post(v); router.refresh(); });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {comments.length === 0 ? (
        <EmptyNote>No comments yet.</EmptyNote>
      ) : (
        <div className="pm-thread">
          {comments.map((c) => (
            <div key={c.id} className="pm-comment">
              <div className="pm-comment__head">
                <span className="pm-comment__author">{c.author_name ?? "Someone"}</span>
                {c.ai && <span className="pm-ai-badge">AI Tracker</span>}
                <span className="pm-comment__time">{when(c.created_at)}</span>
              </div>
              <div className="pm-comment__body">{c.body}</div>
            </div>
          ))}
        </div>
      )}
      <form action={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea
          className="lux-field__control lux-field__control--textarea"
          placeholder="Write a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending || !body.trim()}>
            {pending ? "Posting…" : "Comment"}
          </button>
        </div>
      </form>
    </div>
  );
}
