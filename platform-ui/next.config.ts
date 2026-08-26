import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  // `next dev`, `next build` and Playwright's own dev server all write to the SAME `.next` by default,
  // so a build or an e2e run in this folder while someone's dev server is up corrupts that server
  // ("Cannot find module './1331.js'" from webpack-runtime.js). Verification runs set
  // NEXT_DIST_DIR (e.g. `.next-e2e`, `.next-gate`) and stay out of the running server's folder.
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
