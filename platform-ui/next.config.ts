import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the trace root to this package: the repo lives under a parent folder
  // that has its own lockfile (unrelated sibling projects), which otherwise
  // makes Next infer a wrong workspace root and nest .next/standalone/server.js
  // several directories deep.
  outputFileTracingRoot: __dirname,
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
};
export default nextConfig;
