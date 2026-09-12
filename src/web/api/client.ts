export interface ApiErrorShape {
  error: { code: string; message: string; request_id: string };
}
let csrf: string | null = null;
export function setCsrf(value: string | null): void {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (csrf && !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase()))
    headers.set("X-CSRF-Token", csrf);
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const parsed = (await response.json().catch(() => null)) as
    | ({ data: T } & Partial<{ next_cursor: string | null }>)
    | ApiErrorShape
    | null;
  if (!response.ok) {
    const error = (parsed as ApiErrorShape | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "请求失败。",
    );
  }
  const success = parsed as { data: T; next_cursor?: string | null };
  return Object.prototype.hasOwnProperty.call(success, "next_cursor")
    ? (Object.assign(success.data as object, {
        next_cursor: success.next_cursor,
      }) as T)
    : success.data;
}

export async function requestText(path: string): Promise<string> {
  const response = await fetch(`/api${path}`, { credentials: "same-origin" });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as
      | ApiErrorShape
      | null;
    throw new ApiError(
      response.status,
      parsed?.error.code ?? "REQUEST_FAILED",
      parsed?.error.message ?? "请求失败。",
    );
  }
  return response.text();
}
