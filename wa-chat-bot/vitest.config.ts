import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Serialize test files: the suite mixes a live-Postgres RLS test, a heavy pdf-parse
    // (pdfjs worker) fixture test, and multiple Fastify instances — in parallel they
    // contend and crash the pdfjs worker. Serialized, the suite is deterministic.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
