import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// NestJS DI needs decorator METADATA, which esbuild (vitest's default transform) does not
// emit. unplugin-swc runs SWC instead, honoring .swcrc (legacyDecorator + decoratorMetadata),
// so injected constructor param types resolve — the same reason Nest+vitest setups use SWC.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: 40000,
    testTimeout: 20000,
  },
  plugins: [swc.vite()],
});
