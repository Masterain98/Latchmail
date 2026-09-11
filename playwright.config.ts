import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:8787", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev:worker",
    url: "http://127.0.0.1:8787/healthz",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
