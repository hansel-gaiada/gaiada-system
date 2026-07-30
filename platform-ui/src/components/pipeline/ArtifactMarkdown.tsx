import type { ReactNode } from "react";
import "./pipeline.css";

// WD-02 — renders a pipeline stage's artifact (the AI-drafted PRD/Scope/Report text) as markdown.
//
// SECURITY NOTE (deliberate, matches the house rule already asserted in ChatsTab/TranscriptView/
// GoalDetailClient): artifact text is untrusted model output — the design doc's own prompt-
// injection posture (webdev-design.md §07) treats it exactly like that. This renderer NEVER uses
// dangerouslySetInnerHTML or any HTML-string path; every node below is a real React element built
// from parsed tokens, so there is no DOM-injection surface no matter what the model produced.
// Markdown *links* are the one construct that could otherwise hand the model an attacker-chosen
// href — they are rendered as plain "label (url)" text, never a clickable <a>, for the same reason.
// This is a small, dependency-free renderer (package.json carries no markdown lib) covering the
// subset PRD/Scope/Report extracts actually use: headings, paragraphs, bold/italic/code, fenced
// code blocks, lists, blockquotes, and rules — not full CommonMark.

export function ArtifactMarkdown({ text }: { text: string }) {
  return <div className="pl-md">{renderBlocks(text)}</div>;
}

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block ```...```
    if (/^```/.test(line.trim())) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre className="pl-md__pre" key={`b-${key++}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading — shifted down two levels (h3..h6) since the artifact always sits inside a card
    // that already carries its own <h1>/h3 title; explicit elements avoid a dynamic-tag TS cast.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const content = parseInline(heading[2], `h${key}`);
      const el =
        level === 3 ? <h3 key={`b-${key++}`}>{content}</h3> :
        level === 4 ? <h4 key={`b-${key++}`}>{content}</h4> :
        level === 5 ? <h5 key={`b-${key++}`}>{content}</h5> :
        <h6 key={`b-${key++}`}>{content}</h6>;
      blocks.push(el);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr className="pl-md__hr" key={`b-${key++}`} />);
      i++;
      continue;
    }

    // Blockquote (consume consecutive '>' lines)
    if (/^>\s?/.test(line.trim())) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote className="pl-md__quote" key={`b-${key++}`}>
          {parseInline(quoteLines.join(" "), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul className="pl-md__list" key={`b-${key++}`}>
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it, `ul${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(
        <ol className="pl-md__list" key={`b-${key++}`}>
          {items.map((it, idx) => (
            <li key={idx}>{parseInline(it, `ol${key}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — consume consecutive non-blank, non-special lines, joined with a soft line break.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i].trim()) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^[-*+]\s+/.test(lines[i].trim()) &&
      !/^\d+[.)]\s+/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`b-${key++}`}>
        {paraLines.map((l, idx) => (
          <span key={idx}>
            {parseInline(l, `p${key}-${idx}`)}
            {idx < paraLines.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>,
    );
  }

  return blocks;
}

// Inline tokenizer: code spans first (so markers inside `code` are literal), then bold, italic,
// and links. A single alternation regex keeps ordering correct without re-scanning matched ranges.
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)]+)\)/g;

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(<code className="pl-md__code" key={`${keyPrefix}-${key++}`}>{match[1]}</code>);
    } else if (match[2] !== undefined || match[3] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${key++}`}>{match[2] ?? match[3]}</strong>);
    } else if (match[4] !== undefined || match[5] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${key++}`}>{match[4] ?? match[5]}</em>);
    } else if (match[6] !== undefined) {
      // Plain text, not an <a> — see the file-level SECURITY NOTE.
      nodes.push(`${match[6]} (${match[7]})`);
    }
    last = INLINE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
