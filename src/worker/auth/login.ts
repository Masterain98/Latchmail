import type { Context } from "hono";
import type { Env, WorkerContext } from "../env";
import { loginSchema } from "../../shared/contracts";
import { AppError } from "../../shared/errors";
import { createSession, setSessionCookie } from "./session";
import { sha256, timingSafeEqual } from "../crypto";

type ApiContext = Context<{
  Bindings: Env;
  Variables: { worker: WorkerContext };
}>;
const windowMs = 15 * 60_000;

function clientAddress(c: ApiContext): string {
  return c.req.header("CF-Connecting-IP") ?? "local";
}

export async function login(c: ApiContext): Promise<Response> {
  const now = Date.now();
  const bucket = await sha256(
    new TextEncoder().encode(
      `${clientAddress(c)}:${c.env.SESSION_SECRET.slice(0, 8)}`,
    ),
  );
  const row = await c.env.DB.prepare(
    "SELECT failures FROM auth_rate_limits WHERE bucket_key=? AND expires_at>?",
  )
    .bind(bucket, now)
    .first<{ failures: number }>();
  if ((row?.failures ?? 0) >= 8)
    throw new AppError(429, "RATE_LIMITED", "登录尝试过多，请稍后再试。");
  const body = loginSchema.parse(await c.req.json());
  const [provided, expected] = await Promise.all([
    sha256(new TextEncoder().encode(body.token)),
    sha256(new TextEncoder().encode(c.env.ADMIN_TOKEN)),
  ]);
  if (!timingSafeEqual(provided, expected)) {
    const started = Math.floor(now / windowMs) * windowMs;
    await c.env.DB.prepare(
      "INSERT INTO auth_rate_limits(bucket_key,window_started_at,failures,expires_at) VALUES(?,?,1,?) ON CONFLICT(bucket_key,window_started_at) DO UPDATE SET failures=failures+1,expires_at=excluded.expires_at",
    )
      .bind(bucket, started, started + windowMs)
      .run();
    throw new AppError(401, "UNAUTHORIZED", "管理员口令不正确。");
  }
  await c.env.DB.prepare("DELETE FROM auth_rate_limits WHERE bucket_key=?")
    .bind(bucket)
    .run();
  const session = await createSession(c.env.SESSION_SECRET, now);
  setSessionCookie(c, session.token);
  return c.json({ data: { authenticated: true, csrf: session.csrf } });
}
