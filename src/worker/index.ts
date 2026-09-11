import { Hono } from "hono";
import { ZodError } from "zod";
import { api } from "./http/api";
import type { Env, WorkerContext } from "./env";
import { AppError } from "../shared/errors";
import { requireAuth } from "./auth/session";
import { receiveEmail } from "./receive/service";
import { runMaintenance } from "./maintenance/service";
import { ensureDatabase } from "./database/initialize";

const app = new Hono<{ Bindings: Env; Variables: { worker: WorkerContext } }>();
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("worker", { env: c.env, executionCtx: c.executionCtx, requestId });
  await next();
  c.header("X-Request-Id", requestId);
  if (c.req.path.startsWith("/api/"))
    c.header("Cache-Control", "private, no-store");
});
app.get("/healthz", async (c) => {
  try {
    await ensureDatabase(c.env.DB);
    return c.json({ status: "ok", database: "ready" });
  } catch (error) {
    console.error("database_initialization_failed", {
      requestId: c.get("worker").requestId,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return c.json({ status: "unavailable", database: "migration_failed" }, 503);
  }
});
app.use("/api/*", async (c, next) => {
  await ensureDatabase(c.env.DB);
  return next();
});
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/auth/login") return next();
  return requireAuth(c, next);
});
app.route("/api", api);
app.all(
  "/api/*",
  () =>
    new Response(
      JSON.stringify({
        error: {
          code: "NOT_FOUND",
          message: "接口不存在。",
          request_id: crypto.randomUUID(),
        },
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        },
      },
    ),
);
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  const requestId = c.get("worker")?.requestId ?? crypto.randomUUID();
  if (error instanceof ZodError)
    return c.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: error.issues[0]?.message ?? "请求数据无效。",
          request_id: requestId,
        },
      },
      400,
    );
  if (error instanceof AppError)
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
        },
      },
      error.status as any,
    );
  console.error("request_failed", {
    requestId,
    name: error.name,
    message: error.message,
  });
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器处理失败。",
        request_id: requestId,
      },
    },
    500,
  );
});

export default {
  fetch: app.fetch,
  email: async (
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ) => {
    await ensureDatabase(env.DB);
    return receiveEmail(message, env, ctx);
  },
  scheduled: (
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) =>
    ctx.waitUntil(
      ensureDatabase(env.DB).then(() => runMaintenance(env)),
    ),
} satisfies ExportedHandler<Env>;
