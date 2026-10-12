import { splitLinks } from "@/lib/conversation";

// PV4-09 — a message body, rendered as PLAIN TEXT (design decision 7). `splitLinks` returns data; every part
// becomes a React text node or an <a>, so a body that contains `<img onerror=...>` shows those characters and
// never becomes an element. There is no raw-HTML injection anywhere in the conversation components
// (plainText.guard.test.ts and ThreadView.test.tsx pin both facts).
export function MessageBody({ text, className = "cv-msg__body" }: { text: string; className?: string }) {
  return (
    <p className={className}>
      {splitLinks(text).map((p, i) =>
        p.type === "link" ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.value}</a>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </p>
  );
}
