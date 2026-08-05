// MAIL-13 — the attachment scanner seam, consuming MAIL-14's ClamAV service (design §7.6:
// "Attachments land in a quarantine area of the existing file store and are ClamAV-scanned before any
// user can download (`MAIL_INBOUND_SCAN=clamav`; `scanStatus` gates the download endpoint; `skipped`
// when scanning is off — then downloads are admin-only)").
//
// FAIL-CLOSED ON EXPOSURE is the binding rule: "unscannable stays quarantined". Concretely, the
// scanner has exactly three outcomes and each maps to one `scanStatus`:
//
//   clean    → verified by clamd. The ONLY status the entity-scoped download endpoint will serve.
//   infected → clamd found a signature. The bytes are DISCARDED, not stored (there is no reason for
//              a known-malicious payload to exist on our disk to satisfy a metadata row), and the
//              download endpoint refuses at any privilege.
//   pending  → scanning was requested but did not conclusively answer (clamd unreachable, timed out,
//              returned an unparseable line, or the attachment exceeded clamd's own stream limit).
//              The bytes ARE stored, and the download endpoint refuses. `pending` is the fail-closed
//              state, deliberately not a retry queue in v1 — an operator re-scan path is a follow-up.
//   skipped  → `MAIL_INBOUND_SCAN=off`. Bytes stored, download ADMIN-ONLY per §7.6.
//
// Local dev never reaches clamd: MAIL-14 runs it under its own `scan` compose profile on
// gda-aicenter and the live EICAR path was proven there. The tests here drive `setScannerForTest`
// with a fake, which is what the ticket brief asks for — and the fake is exercised against the same
// interface the clamd client implements, so the EICAR corpus case is a real assertion about this
// module's behaviour rather than about clamd's.
import { Socket } from "node:net";
import { config } from "../../config";

export type ScanVerdict = "clean" | "infected" | "pending";

export interface AttachmentScanner {
  readonly name: string;
  scan(bytes: Buffer): Promise<ScanVerdict>;
}

/** `MAIL_INBOUND_SCAN=off`. Never consulted — the caller short-circuits to `skipped` — but present so
 *  `resolveScanner()` always returns a scanner and no call site has to branch on config. */
const offScanner: AttachmentScanner = {
  name: "off",
  async scan(): Promise<ScanVerdict> {
    return "pending";
  },
};

/**
 * clamd INSTREAM client (the wire protocol the official `clamav/clamav` image speaks on TCP 3310).
 *
 * Protocol: send `zINSTREAM\0`, then a sequence of `<uint32 length BE><chunk>` frames, then a
 * zero-length frame to terminate; clamd replies with one line — `stream: OK`, `stream: <SIG> FOUND`,
 * or an error such as `INSTREAM size limit exceeded`.
 *
 * Written directly on a socket rather than adding a `clamscan`/`clamdjs` dependency: the protocol is
 * the twenty lines below, and every candidate package wraps exactly this while adding a transitive
 * tree to a service whose dependency list is deliberately short.
 */
export function createClamdScanner(host: string, port: number, timeoutMs: number): AttachmentScanner {
  return {
    name: "clamav",
    scan(bytes: Buffer): Promise<ScanVerdict> {
      return new Promise<ScanVerdict>((resolve) => {
        const socket = new Socket();
        let settled = false;
        let response = "";
        // EVERY failure path resolves `pending`, never rejects: a scanner outage must degrade to
        // "stays quarantined", not to a 500 that loses the human's reply entirely.
        const finish = (verdict: ScanVerdict): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(verdict);
        };
        socket.setTimeout(timeoutMs);
        socket.on("timeout", () => finish("pending"));
        socket.on("error", () => finish("pending"));
        socket.on("data", (chunk) => {
          response += chunk.toString("utf8");
          if (!response.includes("\0") && !response.includes("\n")) return;
          const line = response.replace(/\0/g, "").trim();
          if (/\bFOUND\b/.test(line)) finish("infected");
          else if (/\bOK\b/.test(line)) finish("clean");
          else finish("pending"); // includes "INSTREAM size limit exceeded" and any error line
        });
        socket.on("close", () => finish("pending"));
        socket.connect(port, host, () => {
          socket.write("zINSTREAM\0");
          const CHUNK = 64 * 1024;
          for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
            const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.byteLength));
            const header = Buffer.alloc(4);
            header.writeUInt32BE(slice.byteLength, 0);
            socket.write(header);
            socket.write(slice);
          }
          const terminator = Buffer.alloc(4);
          terminator.writeUInt32BE(0, 0);
          socket.write(terminator);
        });
      });
    },
  };
}

let override: AttachmentScanner | null = null;

/** The scanner the intake pipeline uses. `off` returns the no-op scanner; the caller checks
 *  `config.mail.inboundScan` itself to decide between `skipped` and a real scan, so this never
 *  silently turns "off" into "clean". */
export function resolveScanner(): AttachmentScanner {
  if (override) return override;
  if (config.mail.inboundScan !== "clamav") return offScanner;
  return createClamdScanner(config.mail.clamavHost, config.mail.clamavPort, config.mail.clamavTimeoutMs);
}

/** Test seam — clamd lives on the server, not on a dev box (see the header note). */
export function setScannerForTest(scanner: AttachmentScanner | null): void {
  override = scanner;
}

/** The EICAR test string, assembled from parts so this source file is not itself flagged by a
 *  real virus scanner running over the repository (which would be an amusing but genuine CI
 *  breakage). Used by the corpus fixture builder and the scanner tests. */
export function eicarBytes(): Buffer {
  const parts = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!", "$H+H*"];
  return Buffer.from(parts.join(""), "utf8");
}
