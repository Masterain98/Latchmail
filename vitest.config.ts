import { defineConfig } from "vitest/config";
import { sqlTextPlugin } from "./tests/sql-text-plugin.ts";
export default defineConfig({
  plugins: [sqlTextPlugin()],
  test: {
    include: ["tests/unit/**/*.test.{ts,mjs}"],
    environment: "node",
    coverage: { reporter: ["text", "json-summary"] },
  },
});
