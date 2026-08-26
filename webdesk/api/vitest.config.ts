import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Same reason platform-nest's vitest.config.ts gives: NestJS DI needs decorator METADATA
// (constructor param types), which esbuild's transform does not emit. SWC does, honoring
// .swcrc's decoratorMetadata option.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.spec.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
    // Sequential: every spec file shares one throwaway Postgres instance (started once by the
    // caller, per WSK-05's verification runbook) and several files mint/revoke real rows —
    // running them concurrently would race on that shared fixture set.
    fileParallelism: false,
  },
  plugins: [swc.vite()],
});
