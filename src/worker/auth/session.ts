import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, WorkerContext } from "../env";
import { AppError } from "../../shared/errors";
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToBase64,
  hmac,
  sha256,
  timingSafeEqual,
  uuid,
} from "../crypto";

const COOKIE = "__Host-latchmail-session";
const sevenDays = 7 * 86400;
type Variables = { worker: WorkerContext };

async function signature(secret: string, value: string): Promise<string> {
  return bytesToBase64(await hmac(new TextEncoder().encode(secret), value))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export async function createSession(
  secret: string,
  now = Date.now(),
): Promise<{ token: string; csrf: string }> {
  const payload = base64UrlEncode(
    JSON.stringify({ exp: now + sevenDays * 1000, nonce: uuid() }),
  );
  const token = `${payload}.${await signature(secret, payload)}`;
  const decoded = JSON.parse(base64UrlDecode(payload)) as { nonce: string };
  return { token, csrf: await signature(secret, `csrf.${decoded.nonce}`) };
}

export async function verifySession(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<{ csrf: string } | null> {
  if (token.length > 4096) return null;
  const [payload, supplied, extra] = token.split(".");
  if (
    !payload ||
    !supplied ||
    extra ||
    !timingSafeEqual(supplied, await signature(secret, payload))
  )
    return null;
  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as {
      exp: number;
      nonce: string;
    };
    if (
      !Number.isFinite(decoded.exp) ||
      decoded.exp <= now ||
      typeof decoded.nonce !== "string"
    )
      return null;
    return { csrf: await signature(secret, `csrf.${decoded.nonce}`) };
  } catch {
    return null;
  }
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: sevenDays,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE, { secure: true, path: "/" });
}

async function verifyBearer(
  env: Env,
  header: string | undefined,
): Promise<boolean> {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const [a, b] = await Promise.all([
    sha256(new TextEncoder().encode(supplied)),
    sha256(new TextEncoder().encode(env.ADMIN_TOKEN)),
  ]);
  return timingSafeEqual(a, b);
}

export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const worker = c.get("worker");
  if (await verifyBearer(c.env, c.req.header("Authorization"))) {
    worker.authMode = "bearer";
    await next();
    return;
  }
  const token = getCookie(c, COOKIE);
  const session = token
    ? await verifySession(c.env.SESSION_SECRET, token)
    : null;
  if (!session) throw new AppError(401, "UNAUTHORIZED", "请先登录。");
  worker.authMode = "cookie";
  worker.csrf = session.csrf;
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (c.req.header("Origin") !== c.env.APP_ORIGIN)
      throw new AppError(403, "FORBIDDEN", "请求来源校验失败。");
    if (!timingSafeEqual(c.req.header("X-CSRF-Token") ?? "", session.csrf))
      throw new AppError(403, "FORBIDDEN", "CSRF 校验失败。");
  }
  await next();
};
