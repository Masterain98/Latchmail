import { beforeAll } from "vitest";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { inject } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, inject("migrations"));
});

declare module "vitest" {
  export interface ProvidedContext {
    migrations: Array<{ name: string; queries: string[] }>;
  }
}
