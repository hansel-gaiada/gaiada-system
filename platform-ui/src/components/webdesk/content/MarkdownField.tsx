"use client";
import { useId, useState, type ReactNode } from "react";
import { parseMarkdown, type MdInline } from "@/lib/webdeskContentModel";

// A markdown field: the SOURCE is what is edited and stored (verbatim — CommonMark + GFM, never
// normalised, §2.2); the preview is a read-only structural rendering built from React elements, so
// no HTML string is ever assembled from content. `parseMarkdown` (lib/webdeskContentModel.ts) only
// understands headings, lists, paragraphs, emphasis, code, rules and links with a safe scheme — it
// is a PREVIEW, and says so.

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

export function MarkdownField({
  value, onChange, readOnly, describedBy, invalid, pointer, label,
}: {
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  describedBy?: string;
  invalid: boolean;
  pointer: string;
  label: string;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const id = useId();
  return (
    <div className="wc-md">
      <div role="tablist" aria-label={`${label} view`} className="wc-md__tabs">
        <button type="button" role="tab" id={`${id}-w`} aria-selected={tab === "write"} aria-controls={`${id}-wp`} className={`wc-md__tab${tab === "write" ? " wc-md__tab--on" : ""}`} onClick={() => setTab("write")}>Write</button>
        <button type="button" role="tab" id={`${id}-p`} aria-selected={tab === "preview"} aria-controls={`${id}-pp`} className={`wc-md__tab${tab === "preview" ? " wc-md__tab--on" : ""}`} onClick={() => setTab("preview")}>Preview</button>
      </div>
      {tab === "write" ? (
        <div role="tabpanel" id={`${id}-wp`} aria-labelledby={`${id}-w`}>
          <textarea
            className={`lux-field__control lux-field__control--textarea wc-md__source${invalid ? " lux-field__control--error" : ""}`}
            value={value}
            readOnly={readOnly}
            aria-readonly={readOnly || undefined}
            aria-label={label}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            data-pointer={pointer}
            rows={14}
            spellCheck
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      ) : (
        <div role="tabpanel" id={`${id}-pp`} aria-labelledby={`${id}-p`}>
          <MarkdownPreview source={value} />
        </div>
      )}
    </div>
  );
}
