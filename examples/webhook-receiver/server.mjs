import { createServer } from "node:http";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = join(dirname(fileURLToPath(import.meta.url)), "data");
const port = Number(process.env.PORT ?? 8788);
const secretText = process.env.WEBHOOK_SIGNING_SECRET;
if (!secretText) throw new Error("WEBHOOK_SIGNING_SECRET is required");
const secret = Buffer.from(secretText, "base64");
if (secret.length !== 32)
  throw new Error("WEBHOOK_SIGNING_SECRET must decode to exactly 32 bytes");
const maxBytes = 30 * 1024 * 1024;

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw new Error("BOUNDARY_MISSING");
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`),
    parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor >= 0) {
    cursor += boundary.length;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n")))
      cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) throw new Error("MALFORMED_MULTIPART");
    const headers = buffer.subarray(cursor, headerEnd).toString("utf8");
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next < 0) throw new Error("MALFORMED_MULTIPART");
    const content = buffer.subarray(headerEnd + 4, next - 2);
    const name = /name="([^"]+)"/i.exec(headers)?.[1];
    if (!name) throw new Error("PART_NAME_MISSING");
    parts.push({ name, headers, content });
    cursor = next;
  }
  return parts;
}
async function seen(eventId) {
  try {
    await readFile(join(directory, `${eventId}.json`));
    return true;
  } catch {
    return false;
  }
}
async function persist(eventId, payload, raw) {
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.${eventId}.${process.pid}.tmp`),
    target = join(directory, `${eventId}.json`);
  await writeFile(
    temp,
    JSON.stringify(
      {
        received_at: new Date().toISOString(),
        event_id: eventId,
        payload,
        raw_sha256: createHash("sha256").update(raw).digest("hex"),
        raw_size_bytes: raw.length,
      },
      null,
      2,
    ),
  );
  try {
    await rename(temp, target);
  } catch (error) {
    if (await seen(eventId)) return;
    throw error;
  }
}
function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/webhook")
    return json(response, 404, { error: "not_found" });
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > maxBytes) throw new Error("REQUEST_TOO_LARGE");
      chunks.push(chunk);
    }
    const parts = parseMultipart(
      Buffer.concat(chunks),
      String(request.headers["content-type"] ?? ""),
    );
    if (
      parts.length !== 2 ||
      parts.filter((p) => p.name === "payload").length !== 1 ||
      parts.filter((p) => p.name === "raw_email").length !== 1
    )
      throw new Error("PARTS_INVALID");
    const payloadPart = parts.find((p) => p.name === "payload"),
      rawPart = parts.find((p) => p.name === "raw_email");
    const payloadHash = createHash("sha256")
        .update(payloadPart.content)
        .digest("hex"),
      declaredHash = String(request.headers["x-inbox-payload-sha256"] ?? "");
    if (payloadHash !== declaredHash) throw new Error("PAYLOAD_HASH_MISMATCH");
    const eventId = String(request.headers["x-inbox-event-id"] ?? ""),
      deliveryId = String(request.headers["x-inbox-delivery-id"] ?? ""),
      timestamp = String(request.headers["x-inbox-timestamp"] ?? "");
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
      throw new Error("TIMESTAMP_OUT_OF_RANGE");
    const supplied = String(request.headers["x-inbox-signature"] ?? "").replace(
      /^v1,/,
      "",
    );
    const expected = createHmac("sha256", secret)
      .update(`${eventId}.${deliveryId}.${timestamp}.${payloadHash}`)
      .digest();
    const actual = Buffer.from(supplied, "base64");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("SIGNATURE_INVALID");
    const payload = JSON.parse(payloadPart.content.toString("utf8"));
    if (payload.event_id !== eventId) throw new Error("EVENT_ID_MISMATCH");
    const rawHash = createHash("sha256").update(rawPart.content).digest("hex");
    if (
      rawHash !== payload.data.raw_email.sha256 ||
      rawPart.content.length !== payload.data.raw_email.size_bytes
    )
      throw new Error("RAW_INTEGRITY_MISMATCH");
    if (await seen(eventId))
      return json(response, 200, {
        accepted: true,
        duplicate: true,
        event_id: eventId,
      });
    await persist(eventId, payload, rawPart.content);
    return json(response, 202, {
      accepted: true,
      duplicate: false,
      event_id: eventId,
    });
  } catch (error) {
    return json(
      response,
      error instanceof Error && error.message === "REQUEST_TOO_LARGE"
        ? 413
        : 400,
      {
        accepted: false,
        error: error instanceof Error ? error.message : "INVALID_REQUEST",
      },
    );
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Webhook receiver listening on http://127.0.0.1:${port}/webhook`),
);
