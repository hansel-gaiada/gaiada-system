import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // vitest has no "react-server" export condition, so the real package would
      // throw its client-component guard on every server-side test import.
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
});
