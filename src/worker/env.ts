export interface Env {
  DB: D1Database;
  MAIL_STORAGE: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  SESSION_SECRET: string;
  WEBHOOK_SIGNING_SECRET?: string;
  APP_ORIGIN: string;
  ENVIRONMENT: string;
}

export interface WorkerContext {
  env: Env;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  requestId: string;
  authMode?: "cookie" | "bearer";
  csrf?: string;
}
