import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { sqlTextPlugin } from "./tests/sql-text-plugin.ts";

const migrations = await readD1Migrations("./migrations");
export default defineConfig({
  plugins: [
    sqlTextPlugin(),
    cloudflareTest({
      main: "./src/worker/index.ts",
      miniflare: {
        bindings: {
          ADMIN_PASSWORD: "admin-password-with-at-least-thirty-two-bytes",
          ADMIN_API_TOKEN: "independent-api-token-with-at-least-thirty-two-bytes",
          SESSION_SECRET: "session-secret-with-at-least-thirty-two-bytes",
          WEBHOOK_SIGNING_SECRET:
            "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
          APP_ORIGIN: "https://inbox.test",
          ENVIRONMENT: "test",
        },
        d1Databases: [
          "DB",
          "MIGRATION_DB",
          "BASELINE_DB",
          "PARTIAL_DB",
          "RETRY_DB",
          "FETCH_DB",
          "EMAIL_DB",
          "SCHEDULED_DB",
          "CORRUPT_DB",
          "CONFLICT_DB",
        ],
        r2Buckets: ["MAIL_STORAGE"],
        serviceBindings: { ASSETS: () => new Response("asset") },
      },
    }),
  ],
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    provide: { migrations },
    sequence: { concurrent: false },
  },
});
