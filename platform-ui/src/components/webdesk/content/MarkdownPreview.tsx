"use client";
import type { ReactNode } from "react";
import { parseMarkdown, type MdInline } from "@/lib/webdeskContentModel";

// The read-only structural PREVIEW of a markdown source, built from React elements, so no HTML string is ever assembled
// from content. `parseMarkdown` (lib/webdeskContentModel.ts) only understands headings, lists, paragraphs, emphasis, code,
// rules and links with a safe scheme: it is a PREVIEW, and says so. (Moved out of MarkdownField so the visual editor can show
// it as its server-render fallback without an import cycle.)

function renderInline(parts: MdInline[]): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case "strong": return <strong key={i}>{p.v}</strong>;
      case "em": return <em key={i}>{p.v}</em>;
      case "code": return <code key={i}>{p.v}</code>;
      case "link": return <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">{p.v}</a>;
      default: return <span key={i}>{p.v}</span>;
    }
  });
}

export function MarkdownPreview({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return <p className="wc-md__empty">Nothing to preview.</p>;
  return (
    <div className="wc-md__preview" data-testid="markdown-preview">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const H = `h${Math.min(b.level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6"; // never an <h1>: the page owns it
            return <H key={i}>{renderInline(b.inline)}</H>;
          }
          case "p": return <p key={i}>{renderInline(b.inline)}</p>;
          case "ul": return <ul key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;
          case "ol": return <ol key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>;
          case "pre": return <pre key={i}><code>{b.v}</code></pre>;
          case "hr": return <hr key={i} />;
        }
      })}
    </div>
  );
}
