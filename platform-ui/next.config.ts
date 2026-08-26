import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
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
  },
};
export default nextConfig;
