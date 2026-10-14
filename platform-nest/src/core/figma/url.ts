// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36.2) — the Figma URL parser. PURE: no I/O, no clock, no config.
//
// What a user pastes is a share link, and the link is the only thing the ERP stores about a design besides the cache. The
// rules are exactly §36.2's:
//   * hosts: `www.figma.com` and `figma.com` (anything else, including look-alikes such as `figma.com.evil.test` or
//     `notfigma.com`, is refused);
//   * paths: `/design/<key>/…`, `/file/<key>/…` and `/proto/<key>/…`;
//   * the optional `node-id` query parameter uses `-` in the URL and `:` in the API (`1-2` becomes `1:2`).
// Anything else is `bad_figma_url`, with `field: "url"`.
//
// The file key is later interpolated into a Figma API path, so it is held to the alphanumeric alphabet Figma's own keys use
// (never a `/`, `.` or `%`). A pasted link that carries a user name, a password or a port is refused: nothing legitimate does.

export const FIGMA_URL_MAX = 2048;
const HOSTS = new Set(["www.figma.com", "figma.com"]);
const KINDS = new Set(["design", "file", "proto"]);
const KEY_RE = /^[A-Za-z0-9]{1,64}$/;
/** One node id as the URL spells it (`1-2`), the API spells it (`1:2`), or a nested instance spells it (`I1-2;3-4`). */
const NODE_RE = /^I?\d+[-:]\d+(;\d+[-:]\d+)*$/;

export type FigmaLinkKind = "design" | "file" | "proto";

export interface ParsedFigmaUrl {
  kind: FigmaLinkKind;
  fileKey: string;
  /** The frame, in the API form (`1:2`), or null for the whole file. */
  nodeId: string | null;
  /** The link as stored: https, `figma.com` host kept as `www.figma.com`, the pasted kind, the key, and `node-id` only. */
  url: string;
}

/** A refusal the controller turns into 400 `bad_figma_url` with `field: "url"`. */
export class FigmaUrlError extends Error {
  readonly token = "bad_figma_url";
  readonly field = "url";
  constructor(text: string) {
    super(`bad_figma_url: ${text}`);
    this.name = "FigmaUrlError";
  }
}

/** A node id from the URL form to the API form: every `-` becomes `:` (`1-2` is `1:2`, `I1-2;3-4` is `I1:2;3:4`). */
export function nodeIdToApi(urlForm: string): string {
  return urlForm.replace(/-/g, ":");
}

/** A node id from the API form to the URL form (`1:2` is `1-2`), for building a link that opens Figma at a frame. */
export function nodeIdToUrl(apiForm: string): string {
  return apiForm.replace(/:/g, "-");
}

/** Parses a pasted Figma link. Throws FigmaUrlError for anything §36.2 does not accept. */
export function parseFigmaUrl(raw: unknown): ParsedFigmaUrl {
  if (typeof raw !== "string") throw new FigmaUrlError("url must be a string");
  const text = raw.trim();
  if (!text) throw new FigmaUrlError("url is required");
  if (text.length > FIGMA_URL_MAX) throw new FigmaUrlError(`url is longer than ${FIGMA_URL_MAX} characters`);

  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new FigmaUrlError("that is not a link");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FigmaUrlError("only http(s) links are accepted");
  if (u.username || u.password || u.port) throw new FigmaUrlError("a Figma link carries no credentials or port");
  if (!HOSTS.has(u.hostname.toLowerCase())) throw new FigmaUrlError("that is not a figma.com link");

  const segments = u.pathname.split("/").filter((s) => s !== "");
  const kind = segments[0];
  const fileKey = segments[1];
  if (!kind || !KINDS.has(kind)) throw new FigmaUrlError("the link must be a /design/, /file/ or /proto/ link");
  if (!fileKey || !KEY_RE.test(fileKey)) throw new FigmaUrlError("the link has no valid file key");

  let nodeId: string | null = null;
  const nodeParam = u.searchParams.get("node-id");
  if (nodeParam !== null) {
    if (!NODE_RE.test(nodeParam)) throw new FigmaUrlError("node-id is not a frame id");
    nodeId = nodeIdToApi(nodeParam);
  }

  const url = `https://www.figma.com/${kind}/${fileKey}${nodeId ? `?node-id=${nodeIdToUrl(nodeId)}` : ""}`;
  return { kind: kind as FigmaLinkKind, fileKey, nodeId, url };
}
