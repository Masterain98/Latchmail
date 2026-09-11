const encoder = new TextEncoder();

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const value of new Uint8Array(bytes))
    binary += String.fromCharCode(value);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    result[index] = binary.charCodeAt(index);
  return result;
}

export function base64UrlEncode(value: string): string {
  return bytesToBase64(encoder.encode(value))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function base64UrlDecode(value: string): string {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new TextDecoder().decode(base64ToBytes(base64));
}

export async function sha256(value: ArrayBuffer | Uint8Array): Promise<string> {
  const safe = value instanceof Uint8Array ? Uint8Array.from(value) : value;
  return bytesToHex(await crypto.subtle.digest("SHA-256", safe));
}

export async function hmac(
  secret: ArrayBuffer | Uint8Array,
  value: string,
): Promise<ArrayBuffer> {
  const safe = secret instanceof Uint8Array ? Uint8Array.from(secret) : secret;
  const key = await crypto.subtle.importKey(
    "raw",
    safe,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let result = left.length ^ right.length;
  for (let i = 0; i < length; i++)
    result |=
      (left[i % Math.max(1, left.length)] ?? 0) ^
      (right[i % Math.max(1, right.length)] ?? 0);
  return result === 0;
}

export function uuid(): string {
  return crypto.randomUUID();
}
