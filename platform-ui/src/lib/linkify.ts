// PV4-12 — the ONE plain-text -> text/link parts splitter, shared by the staff conversation (MessageBody) and the
// client portal (PortalThreadView). It returns DATA: the renderer builds React text nodes and <a>, so a body that
// contains markup (`<img onerror=...>`) stays literal text. A link is only ever `http:` or `https:`, must parse
// with `new URL`, and trailing punctuation stays outside the link. `javascript:`, `data:` and `ftp:` never link.

export type BodyPart = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;

export function linkify(text: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    const trail = url.match(TRAILING)?.[0] ?? "";
    if (trail) url = url.slice(0, url.length - trail.length);
    let href: string | null = null;
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") href = u.toString();
    } catch { /* not a URL: stays text */ }
    if (!href) continue;
    if (start > last) parts.push({ type: "text", value: text.slice(last, start) });
    parts.push({ type: "link", value: url, href });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}
