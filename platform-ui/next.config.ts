import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the trace root to this package: the repo lives under a parent folder
  // that has its own lockfile (unrelated sibling projects), which otherwise
  // makes Next infer a wrong workspace root and nest .next/standalone/server.js
  // several directories deep.
  outputFileTracingRoot: __dirname,
};
export default nextConfig;
