import { AppError } from "../../shared/errors";

export async function one<T>(
  statement: D1PreparedStatement,
): Promise<T | null> {
  return (await statement.first<T>()) ?? null;
}

export async function required<T>(
  statement: D1PreparedStatement,
  message = "资源不存在。",
): Promise<T> {
  const row = await one<T>(statement);
  if (!row) throw new AppError(404, "NOT_FOUND", message);
  return row;
}

export function changed(result: D1Result): boolean {
  return Number(result.meta.changes ?? 0) > 0;
}

export function iso(value: number | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

export function jsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
