// hermes-gateway/stream-parser.mjs — ASST-14
//
// Incremental, line-oriented parser for Hermes' decorated `chat` transcript, built for streaming.
//
// Today's one-shot `extractChatReply` (server.mjs) needs the WHOLE buffered stdout to find the
// "╭─ ⚕ Hermes ─╮" ... "╰...╯" box, so it cannot be reused unchanged once stdout arrives a chunk
// at a time. This module is the streaming replacement: a state machine over LINES, not bytes.
//
// Why lines, not bytes: a chunk boundary can land anywhere — mid box-open marker, mid ANSI escape,
// mid body line — but every one of those only ever matters WITHIN a single logical line. Buffering
// into a "carry" string until a newline (or end-of-stream) arrives reassembles any such split
// before a line is ever inspected, which is what makes the state machine itself trivial: by the
// time a line reaches `#processLine`, it is always whole. The only place a genuine partial can
// still surface is the very last, newline-less line at end-of-stream (a killed/crashed process) —
// handled explicitly in `stripAnsi` and in `end()`.
//
// States: PRE (preamble like "Query:"/"Initializing…" before the box opens — discarded) -> BODY
// (between the box-open and box-close markers; each line is border-stripped and emitted) -> POST
// (footer like "Session:"/"Resume…" after the box closes — scanned ONLY for the session id,
// otherwise discarded). Reaching POST is the ONLY success terminal: a stream that ends in PRE or
// BODY (Hermes died, or was killed by the gateway's own timeout, before printing the closing "╰")
// must always be reported as an error by the caller — never as a truncated "complete" answer, and
// never left hanging (that half of the contract is the caller's job via `boxClosed`).

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const BOX_TOP = /^\s*╭.*Hermes/;
const BOX_BOTTOM = /^\s*╰/;
const BORDER_LEAD = /^\s*[│┃]?\s?/;
const BORDER_TRAIL = /\s*[│┃]\s*$/;
const SESSION_LINE = /Session:\s*(\S+)/i;

export const PARSE_STATE = Object.freeze({ PRE: "PRE", BODY: "BODY", POST: "POST" });

/** Strip complete ANSI escapes. A trailing INCOMPLETE escape (a bare ESC with no terminator yet)
 *  can only happen on the final, still-unterminated line at end-of-stream — strip from the last
 *  bare ESC to the end rather than ever leak a raw escape byte to a consumer. */
function stripAnsi(line) {
  const withoutComplete = line.replace(ANSI, "");
  const lastEsc = withoutComplete.lastIndexOf("\x1b");
  return lastEsc === -1 ? withoutComplete : withoutComplete.slice(0, lastEsc);
}

export class HermesBoxStreamParser {
  #state = PARSE_STATE.PRE;
  #carry = "";
  #sessionId = null;
  #emittedFirst = false;
  #onToken;

  constructor(onToken) {
    this.#onToken = onToken;
  }

  get state() {
    return this.#state;
  }
  get sessionId() {
    return this.#sessionId;
  }
  /** True only once the box's closing "╰" line has actually been seen — the success terminal. */
  get boxClosed() {
    return this.#state === PARSE_STATE.POST;
  }

  /** Feed one stdout chunk (string). May contain zero, one, or many complete lines, plus a
   *  trailing partial line that is held in the carry buffer until the next feed() or end(). */
  feed(chunk) {
    this.#carry += chunk;
    let idx;
    while ((idx = this.#carry.indexOf("\n")) !== -1) {
      const line = this.#carry.slice(0, idx).replace(/\r$/, "");
      this.#carry = this.#carry.slice(idx + 1);
      this.#processLine(line);
    }
  }

  /** Call once, when stdout ends (process exit/close). Flushes a trailing newline-less line —
   *  Hermes terminates every real line, so this only ever fires on a killed/crashed process. */
  end() {
    if (this.#carry.length > 0) {
      const line = this.#carry;
      this.#carry = "";
      this.#processLine(line);
    }
  }

  #processLine(rawLine) {
    const line = stripAnsi(rawLine);
    if (this.#state === PARSE_STATE.PRE) {
      if (BOX_TOP.test(line)) this.#state = PARSE_STATE.BODY;
      return; // preamble is never emitted
    }
    if (this.#state === PARSE_STATE.BODY) {
      if (BOX_BOTTOM.test(line)) {
        this.#state = PARSE_STATE.POST;
        return;
      }
      const content = line.replace(BORDER_LEAD, "").replace(BORDER_TRAIL, "").trimEnd();
      // Reconstruct the original multi-line text across separate token frames: the first content
      // line is emitted bare, every subsequent one is prefixed with the newline that joins it to
      // the previous line — so concatenating all emitted frames in order reproduces the exact text
      // extractChatReply would have produced from the whole buffer, with no trailing newline.
      const piece = this.#emittedFirst ? "\n" + content : content;
      this.#emittedFirst = true;
      this.#onToken(piece);
      return;
    }
    // POST: footer — the only thing worth extracting is the session id (first occurrence wins).
    if (this.#sessionId === null) {
      const m = SESSION_LINE.exec(line);
      if (m) this.#sessionId = m[1];
    }
  }
}

/** Parse a HERMES_BIN config value that is either a single executable ("hermes", the production
 *  default) or a quoted multi-token command line (e.g.
 *  `"C:\Program Files\nodejs\node.exe" "C:\path\fixture.mjs"`), used by tests to run a fake Hermes
 *  via `node <script>` directly — Windows `spawn` cannot execute a script by shebang alone, and
 *  quoting is needed because both `node.exe`'s own install path and arbitrary fixture paths may
 *  contain spaces. Deliberately a simple tokenizer (quoted-or-bare-whitespace-run), not a shell
 *  lexer — the single-token production case ("hermes") is untouched by this at all. */
export function tokenizeCommand(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/** argv for a Hermes `chat` turn on the streaming endpoint. Deliberately NOT shared with
 *  server.mjs's `runHermes` (which builds its own, separate chat argv for `/media`'s image path) —
 *  the two must stay independently correct so a change here can never silently alter the one-shot
 *  `/media` contract wa-chat-bot depends on. */
export function buildHermesChatStreamArgs({ prompt, providerSession, modelArgs = [], extraArgs = [] }) {
  const args = ["chat", "-q", prompt];
  if (providerSession) args.push("--resume", providerSession);
  return [...args, ...modelArgs, ...extraArgs];
}
