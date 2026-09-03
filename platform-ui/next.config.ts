import type { NextConfig } from "next";

// BOOT GUARD — refuse to start a production runtime with the demo harness enabled. next.config.ts
// is evaluated by `next build` and `next start` before any request is served, so a deployment
// carrying a stray DEMO_MODE=1 dies here rather than bypassing LOGIN (app/login/actions.ts accepts
// any email in demo mode) and answering real users from in-memory fixtures, all behind healthy
// 200s. Duplicated at the call sites via lib/demoMode.ts on purpose: this stops the process, that
// stops the fiction if anything ever gets past this. Inlined because next.config.ts is loaded
// outside the app's module graph and its TS path aliases.
if (process.env.DEMO_MODE === "1" && process.env.NODE_ENV === "production") {
  throw new Error(
    "DEMO_MODE=1 is set while NODE_ENV=production. Refusing to start: demo mode bypasses login and " +
      "answers every API read from in-memory fixtures, so this deployment would serve invented data " +
      "to real users while appearing completely healthy. Unset DEMO_MODE — it is a local " +
      "verification harness and is never valid in production. See src/lib/demoMode.ts.",
  );
}
const nextConfig: NextConfig = {
  output: "standalone",
  // Build directory, overridable per process. It stays `.next` unless NEXT_DIST_DIR is set, so
  // nothing about a normal `npm run dev` / `npm run build` changes.
  //
  // Why it is overridable: several dev servers are routinely run against this one working copy at
  // the same time (concurrent sessions, agent worktrees). They all write the SAME `.next`, and the
  // moment one of them recompiles, the others start serving 500s on a missing
  // `routes-manifest.json` — a failure that looks like a broken app but is really two processes
  // sharing one build dir. Setting NEXT_DIST_DIR=.next-<something> gives a second server its own
  // and makes them independent.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Pin the trace root to this package: the repo lives under a parent folder
  // that has its own lockfile (unrelated sibling projects), which otherwise
  // makes Next infer a wrong workspace root and nest .next/standalone/server.js
  // several directories deep.
  outputFileTracingRoot: __dirname,
  experimental: {
    serverActions: {
      // Server Actions default to a 1 MB body. Two upload paths still go through actions —
      // `uploadAudioAction` (the in-browser take from LiveRecorder) and
      // `registerAndUploadAudioAction` — and a 200 MB video failed with "Body exceeded 1 MB limit"
      // before anything reached the platform. Sized to the platform's own video cap
      // (MEETING_VIDEO_MAX_BYTES, default 500 MB) plus multipart overhead; the platform enforces
      // the real limit and answers 413. The PRD Studio file upload does NOT use an action at all —
      // it streams through `app/api/meetings/[id]/audio` so the browser can show progress.
      bodySizeLimit: "520mb",
    },
    // Second body cap, and the one that actually bit: because this app has a `middleware.ts`, Next
    // buffers every request body so middleware can read it, and cuts it at this size (default
    // 10 MB). A 170 MB upload reached `api/meetings/[id]/audio` as exactly 10,485,248 bytes, the
    // platform's multipart parser choked on the truncated body, and the controller reported
    // "exceeds cap". Same ceiling as the server-action limit above, for the same reason.
    middlewareClientMaxBodySize: 520 * 1024 * 1024,
  },
};
export default nextConfig;
