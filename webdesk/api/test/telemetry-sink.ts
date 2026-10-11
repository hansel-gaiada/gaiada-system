// M4 telemetry — a tiny local OTLP/HTTP sink for test/telemetry-*.spec.ts: counts what is POSTed, records the
// headers and raw body, and can be switched to answer with an error or to never answer.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

// ---------------------------------------------------------------------------------------------------------
// A tiny OTLP/HTTP sink. `mode` can be changed while it runs: "ok" answers 200, "503"/"401" answer that
// status, "hang" accepts the request and never answers (a black-holed collector).
// ---------------------------------------------------------------------------------------------------------
export type SinkMode = "ok" | "503" | "401" | "hang";
export interface SinkPost {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
export interface Sink {
  port: number;
  mode: SinkMode;
  posts: SinkPost[];
  /** Resolves once at least `n` POSTs to /v1/traces were seen (or rejects after `timeoutMs`). */
  waitForTracePosts(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startSink(port = 0, mode: SinkMode = "ok"): Promise<Sink> {
  const sockets = new Set<Socket>();
  const posts: SinkPost[] = [];
  const sink: Sink = {
    port,
    mode,
    posts,
    async waitForTracePosts(n, timeoutMs = 10_000) {
      const t0 = Date.now();
      while (posts.filter((p) => p.method === "POST" && p.url === "/v1/traces").length < n) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`sink saw ${posts.length} posts, wanted ${n} within ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      posts.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      if (sink.mode === "hang") return; // never answer
      const status = sink.mode === "ok" ? 200 : Number(sink.mode);
      res.writeHead(status, { "content-type": "application/x-protobuf" });
      res.end();
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  sink.port = (server.address() as AddressInfo).port;
  return sink;
}

/** A port nothing is listening on right now (bind, read the number, release). */
export async function closedPort(): Promise<number> {
  const s = await startSink();
  const p = s.port;
  await s.close();
  return p;
}
