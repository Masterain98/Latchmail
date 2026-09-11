import { AppError } from "./errors";

const asciiDomain =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const asciiLocal = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;

export function normalizeDomain(value: string): string {
  const normalized = value.trim().replace(/\.$/, "").toLowerCase();
  let ascii: string;
  try {
    ascii = new URL(`https://${normalized}`).hostname;
  } catch {
    throw new AppError(400, "BAD_REQUEST", "域名格式无效。");
  }
  if (!asciiDomain.test(ascii))
    throw new AppError(400, "BAD_REQUEST", "域名格式无效。");
  return ascii;
}

export function normalizeLocalPart(value: string): string {
  const normalized = value.trim().normalize("NFC").toLowerCase();
  if (
    !asciiLocal.test(normalized) ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..")
  )
    throw new AppError(
      400,
      "BAD_REQUEST",
      "首版登记仅支持常见 ASCII local-part。",
    );
  return normalized;
}

export function normalizeAddress(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) throw new AppError(400, "BAD_REQUEST", "邮箱地址格式无效。");
  return `${normalizeLocalPart(value.slice(0, at))}@${normalizeDomain(value.slice(at + 1))}`;
}

export function normalizeEnvelopeAddress(value: string): {
  address: string;
  domain: string;
} {
  const trimmed = value.trim().normalize("NFC");
  const at = trimmed.lastIndexOf("@");
  if (at <= 0)
    throw new AppError(400, "BAD_REQUEST", "Envelope 收件地址格式无效。");
  const domain = normalizeDomain(trimmed.slice(at + 1));
  return { address: `${trimmed.slice(0, at).toLowerCase()}@${domain}`, domain };
}

export function normalizeTag(value: string): { name: string; key: string } {
  const name = value.trim().normalize("NFC");
  if ([...name].length < 1 || [...name].length > 64)
    throw new AppError(400, "BAD_REQUEST", "标签名称长度应为 1～64 个字符。");
  return { name, key: name.toLocaleLowerCase("und") };
}

export function safeDownloadName(
  value: string | null | undefined,
  fallback = "attachment.bin",
): string {
  const cleaned = [...(value ?? fallback)]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || '/\\:"'.includes(character)
        ? "_"
        : character;
    })
    .join("")
    .trim();
  return cleaned.slice(0, 180) || fallback;
}
