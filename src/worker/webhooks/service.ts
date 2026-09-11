import type { Env } from "../env";
import { base64ToBytes, bytesToBase64, hmac, uuid } from "../crypto";

const backoffMs = [
  60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000,
];
interface DeliveryRow {
  id: string;
  message_id: string;
  event_id: string;
  endpoint_url_snapshot: string;
  endpoint_revision: number;
  attempts_total: number;
  cycle_attempts: number;
  cycle_started_at: number | null;
  retry_deadline_at: number | null;
  raw_object_key: string;
  raw_expires_at: number;
  raw_sha256: string;
  raw_size_bytes: number;
  content_object_key: string;
  content_sha256: string;
  content_size_bytes: number;
}

function multipart(
  payload: R2ObjectBody,
  raw: R2ObjectBody,
  boundary: string,
  rawFilename: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  void (async () => {
    const writeText = (value: string) => writer.write(encoder.encode(value));
    const pipe = async (source: ReadableStream<Uint8Array>) => {
      const reader = source.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          await writer.write(item.value);
        }
      } finally {
        reader.releaseLock();
      }
    };
    try {
      await writeText(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
      );
      await pipe(payload.body);
      await writeText(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="raw_email"; filename="${rawFilename.replace(/[\r\n"]/g, "_")}"\r\nContent-Type: message/rfc822\r\n\r\n`,
      );
      await pipe(raw.body);
      await writeText(`\r\n--${boundary}--\r\n`);
      await writer.close();
    } catch (error) {
      await writer.abort(error);
    }
  })();
  return stream.readable;
}

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
function jitter(ms: number): number {
  const bytes = new Uint16Array(1);
  crypto.getRandomValues(bytes);
  return Math.round(ms * (0.95 + (bytes[0]! / 65535) * 0.1));
}

function retryAfter(response: Response, now: number): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return now + Math.min(seconds, 86400) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) && date > now ? date : null;
}

async function excerpt(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (result.length < 1024) {
      const part = await reader.read();
      if (part.done) break;
      result += decoder.decode(part.value, { stream: true });
    }
    await reader.cancel();
  } catch {
    await reader.cancel().catch(() => undefined);
  }
  return result
    .slice(0, 1024)
    .replace(
      /(authorization|cookie|token|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
}

export async function sendWebhookParts(
  env: Env,
  row: Pick<
    DeliveryRow,
    "id" | "event_id" | "endpoint_url_snapshot" | "content_sha256"
  >,
  payload: R2ObjectBody,
  raw: R2ObjectBody,
  rawFilename: string,
  now: number,
  signal?: AbortSignal,
): Promise<Response> {
  if (!env.WEBHOOK_SIGNING_SECRET) throw new Error("WEBHOOK_SECRET_MISSING");
  const secret = base64ToBytes(env.WEBHOOK_SIGNING_SECRET);
  if (secret.byteLength !== 32) throw new Error("WEBHOOK_SECRET_INVALID");
  const timestamp = Math.floor(now / 1000).toString();
  const signable = `${row.event_id}.${row.id}.${timestamp}.${row.content_sha256}`;
  const signature = bytesToBase64(await hmac(secret, signable));
  const boundary = `latchmail-${uuid().replace(/-/g, "")}`;
  return fetch(row.endpoint_url_snapshot, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "X-Inbox-Event-Id": row.event_id,
      "X-Inbox-Delivery-Id": row.id,
      "X-Inbox-Timestamp": timestamp,
      "X-Inbox-Payload-SHA256": row.content_sha256,
      "X-Inbox-Signature": `v1,${signature}`,
      "User-Agent": "Latchmail/1.0",
    },
    body: multipart(payload, raw, boundary, rawFilename),
  });
}

export async function processWebhookBatch(
  env: Env,
  now = Date.now(),
  limit = 2,
): Promise<number> {
  let completed = 0;
  const due = await env.DB.prepare(
    "SELECT d.id,d.message_id,d.event_id,d.endpoint_url_snapshot,d.endpoint_revision,d.attempts_total,d.cycle_attempts,d.cycle_started_at,d.retry_deadline_at,m.raw_object_key,m.raw_expires_at,m.raw_sha256,m.raw_size_bytes,m.content_object_key,m.content_sha256,m.content_size_bytes FROM webhook_deliveries d JOIN messages m ON m.id=d.message_id JOIN app_settings s ON s.singleton=1 WHERE d.status IN ('pending','retry_wait','inflight') AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?) AND (d.status!='inflight' OR d.lease_until<=?) AND m.deleted_at IS NULL AND d.endpoint_revision=s.webhook_revision AND s.webhook_enabled=1 ORDER BY COALESCE(d.next_attempt_at,d.created_at) LIMIT ?",
  )
    .bind(now, now, limit)
    .all<DeliveryRow>();
  await Promise.all(
    due.results.map(async (row) => {
      if (row.raw_expires_at <= now) {
        await env.DB.prepare(
          "UPDATE webhook_deliveries SET status='expired',last_error_code='CONTENT_EXPIRED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",
        )
          .bind(now, row.id)
          .run();
        return;
      }
      const lease = uuid();
      const cycleStart = row.cycle_started_at ?? now;
      const deadline = Math.min(cycleStart + 86400000, row.raw_expires_at);
      const claim = await env.DB.prepare(
        "UPDATE webhook_deliveries SET status='inflight',lease_token=?,lease_until=?,attempts_total=attempts_total+1,cycle_attempts=cycle_attempts+1,cycle_started_at=COALESCE(cycle_started_at,?),retry_deadline_at=?,updated_at=? WHERE id=? AND status IN ('pending','retry_wait','inflight') AND (status!='inflight' OR lease_until<=?)",
      )
        .bind(lease, now + 90000, cycleStart, deadline, now, row.id, now)
        .run();
      if (!Number(claim.meta.changes)) return;
      const attempt = row.attempts_total + 1;
      const attemptId = uuid();
      await env.DB.prepare(
        "INSERT INTO webhook_attempts(id,delivery_id,attempt_number,started_at,result) VALUES(?,?,?,?,'started')",
      )
        .bind(attemptId, row.id, attempt, now)
        .run();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let response: Response | null = null;
      let errorCode: string | null = null;
      try {
        const [payload, raw] = await Promise.all([
          env.MAIL_STORAGE.get(row.content_object_key),
          env.MAIL_STORAGE.get(row.raw_object_key),
        ]);
        if (!payload || !raw)
          throw new Error(!raw ? "RAW_MISSING" : "CONTENT_MISSING");
        response = await sendWebhookParts(
          env,
          row,
          payload,
          raw,
          `${row.message_id}.eml`,
          now,
          controller.signal,
        );
      } catch (error) {
        errorCode =
          error instanceof Error && error.name === "AbortError"
            ? "TIMEOUT"
            : error instanceof Error
              ? error.message.slice(0, 80)
              : "NETWORK_ERROR";
      } finally {
        clearTimeout(timeout);
      }
      const finished = Date.now();
      const bodyExcerpt = response ? await excerpt(response) : "";
      const status = response?.status ?? null;
      if (response && status != null && status >= 200 && status < 300) {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE webhook_attempts SET finished_at=?,http_status=?,duration_ms=?,result='succeeded',response_excerpt=? WHERE id=?",
          ).bind(finished, status, finished - now, bodyExcerpt, attemptId),
          env.DB.prepare(
            "UPDATE webhook_deliveries SET status='succeeded',delivered_at=?,last_http_status=?,last_error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?",
          ).bind(finished, status, finished, row.id, lease),
        ]);
        completed++;
        return;
      }
      const canRetry = !response || (status != null && retryable(status));
      const cycleAttempts = row.cycle_attempts + 1;
      const baseNext =
        now +
        jitter(backoffMs[Math.min(cycleAttempts - 1, backoffMs.length - 1)]!);
      const hinted = response ? retryAfter(response, now) : null;
      const next = Math.max(baseNext, hinted ?? 0);
      const terminal = !canRetry || cycleAttempts >= 8 || next >= deadline;
      const finalError =
        errorCode ?? (status ? `HTTP_${status}` : "NETWORK_ERROR");
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE webhook_attempts SET finished_at=?,http_status=?,duration_ms=?,result=?,error_code=?,response_excerpt=? WHERE id=?",
        ).bind(
          finished,
          status,
          finished - now,
          terminal ? "failed" : "retry",
          finalError,
          bodyExcerpt,
          attemptId,
        ),
        env.DB.prepare(
          "UPDATE webhook_deliveries SET status=?,next_attempt_at=?,last_http_status=?,last_error_code=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?",
        ).bind(
          terminal ? "failed" : "retry_wait",
          terminal ? null : next,
          status,
          finalError,
          finished,
          row.id,
          lease,
        ),
      ]);
      completed++;
    }),
  );
  return completed;
}

export { backoffMs };
