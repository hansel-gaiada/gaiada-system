// WSK-07 — ClamAV scan on ingest, via clamd's own `INSTREAM` wire protocol directly over a raw TCP
// socket (node:net). No npm client library added: INSTREAM is a small, stable, documented
// protocol (chunked length-prefixed body, terminated by a zero-length chunk, followed by a single
// line reply), and hand-rolling it here avoids a new dependency for what is ~40 lines of code.
//
// Protocol (clamd docs, `INSTREAM`):
//   1. Send "zINSTREAM\0" (the 'z' prefix = NUL-terminated command).
//   2. Send the file as a sequence of chunks: each chunk is a 4-byte BIG-ENDIAN length prefix
//      followed by that many bytes of file data.
//   3. Send a final zero-length chunk (4 zero bytes) to signal end-of-stream.
//   4. Read clamd's reply: "stream: OK" (clean) or "stream: <SIGNATURE> FOUND" (infected), or an
//      "... ERROR" line.
//
// FAIL CLOSED: any connection/protocol failure (clamd unreachable, timeout, malformed reply)
// throws rather than returning "clean" — an upload the scanner could not actually inspect must
// never be treated as safe. See media.service.ts's caller, which turns that into a 503, not a
// silent pass-through.
import { Injectable } from "@nestjs/common";
import { Socket } from "node:net";

export type ClamScanResult = { infected: false } | { infected: true; signature: string };

export type ClamAvConfig = { host: string; port: number; timeoutMs?: number };

@Injectable()
export class ClamAvService {
  async scanBuffer(buffer: Buffer, cfg: ClamAvConfig): Promise<ClamScanResult> {
    const reply = await this.instream(buffer, cfg);
    return parseClamReply(reply);
  }

  private instream(buffer: Buffer, cfg: ClamAvConfig): Promise<string> {
    const timeoutMs = cfg.timeoutMs ?? 15_000;
    return new Promise<string>((resolve, reject) => {
      const socket = new Socket();
      let settled = false;
      const chunks: Buffer[] = [];

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      const succeed = (value: string) => {
        if (settled) return;
        settled = true;
        socket.end();
        resolve(value);
      };

      socket.setTimeout(timeoutMs, () => fail(new Error(`clamd INSTREAM timed out after ${timeoutMs}ms`)));
      socket.on("error", (err) => fail(err));
      socket.on("data", (d) => chunks.push(d));
      socket.on("close", () => {
        if (settled) return;
        // Socket closed before a full reply line was seen — clamd always replies before closing on
        // success, so this is a protocol-level failure, not "no virus found".
        fail(new Error("clamd closed the connection before replying"));
      });

      socket.connect(cfg.port, cfg.host, () => {
        socket.write("zINSTREAM\0");

        // clamd caps chunk size at StreamMaxLength server-side but has no minimum; sending the
        // whole buffer as one chunk (bounded by the api's own upload size cap, well under any
        // clamd default) keeps this simple without needing to negotiate chunk sizing.
        const lenPrefix = Buffer.alloc(4);
        lenPrefix.writeUInt32BE(buffer.length, 0);
        socket.write(lenPrefix);
        socket.write(buffer);

        const zeroChunk = Buffer.alloc(4); // length 0 == end of stream
        socket.write(zeroChunk);
      });

      // Resolve once we've seen a newline-terminated reply — clamd sends exactly one reply line
      // for INSTREAM and then closes.
      socket.on("data", () => {
        const combined = Buffer.concat(chunks).toString("utf8");
        if (combined.includes("\n") || combined.includes("\0")) {
          succeed(combined.replace(/\0/g, "").trim());
        }
      });
    });
  }
}

export function parseClamReply(reply: string): ClamScanResult {
  // Typical replies: "stream: OK", "stream: Eicar-Test-Signature FOUND", "stream: <msg> ERROR".
  if (/\bERROR\b/.test(reply)) {
    throw new Error(`clamd reported an error: ${reply}`);
  }
  const foundMatch = /stream:\s*(.+?)\s+FOUND/.exec(reply);
  if (foundMatch) {
    return { infected: true, signature: foundMatch[1] };
  }
  if (/stream:\s*OK/.test(reply)) {
    return { infected: false };
  }
  throw new Error(`clamd sent an unrecognized reply: ${reply}`);
}
