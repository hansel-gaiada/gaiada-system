import type { ReactNode } from "react";
// ASST-07 — a hand-rolled, minimal markdown-ish renderer. platform-ui's runtime deps are pinned to
// `next`/`react`/`react-dom`/`server-only` (see CLAUDE.md) — no markdown library, same discipline
// that keeps the reports kit's charts hand-rolled SVG instead of a chart library. Covers exactly
// what a model reply needs: paragraphs, fenced code blocks (with a language label), inline code,
// bold/italic, and simple `-`/`*` bullet lists. Everything renders as React elements built from
// plain-text nodes — never `dangerouslySetInnerHTML` — so there is no HTML-injection surface even
// though the source text is model output, not something we authored.

interface CodeBlock { kind: "code"; lang: string | null; code: string }
interface TextBlock { kind: "text"; lines: string[] }
type Block = CodeBlock | TextBlock;

/** Splits raw text into fenced-code vs. everything-else blocks. Fences must start the line (```lang)
 *  and a bare ``` closes — the common case for model output, not a full CommonMark fence parser. */
function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let textBuf: string[] = [];
  const flushText = () => {
    if (textBuf.length) {
      blocks.push({ kind: "text", lines: textBuf });
      textBuf = [];
    }
  };
  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```\s*([\w+-]*)\s*$/);
    if (fenceMatch) {
      flushText();
      const lang = fenceMatch[1] || null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or EOF if the stream was cut mid-block — still renders what we have)
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }
    textBuf.push(lines[i]);
    i++;
  }
  flushText();
  return blocks;
}

/** Bold/italic/inline-code within one line of plain text -> React nodes. Deliberately simple regex
 *  passes (not a tokenizer) — good enough for model output, which rarely nests these. */
function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Split on the three inline forms, keeping the delimiters so we know which matched.
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) nodes.push(line.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-${idx++}`} className="asst-inline-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-${idx++}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={`${keyPrefix}-${idx++}`}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
}

function renderTextBlock(block: TextBlock, keyPrefix: string): ReactNode {
  // Blank-line-separated paragraphs; a run of `-`/`*`-prefixed lines becomes one <ul>.
  const elements: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let elIdx = 0;
  const flushPara = () => {
    if (para.length === 0) return;
    elements.push(
      <p key={`${keyPrefix}-p-${elIdx++}`} className="asst-md-p">
        {para.map((ln, i) => (
          <span key={i}>
            {renderInline(ln, `${keyPrefix}-p-${elIdx}-${i}`)}
            {i < para.length - 1 && <br />}
          </span>
        ))}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    elements.push(
      <ul key={`${keyPrefix}-ul-${elIdx++}`} className="asst-md-ul">
        {list.map((item, i) => <li key={i}>{renderInline(item, `${keyPrefix}-li-${i}`)}</li>)}
      </ul>,
    );
    list = [];
  };
  for (const raw of block.lines) {
    const line = raw;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return elements;
}

/** Renders model reply text as safe React nodes — no HTML injection surface, no markdown library. */
export function renderMarkdownLite(text: string): ReactNode {
  const blocks = splitBlocks(text);
  return blocks.map((b, i) => {
    if (b.kind === "code") {
      return (
        <pre key={i} className="asst-code-block">
          {b.lang && <span className="asst-code-lang">{b.lang}</span>}
          <code>{b.code}</code>
        </pre>
      );
    }
    return <span key={i}>{renderTextBlock(b, `b${i}`)}</span>;
  });
}
