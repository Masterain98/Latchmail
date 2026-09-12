import type { Env } from "../env";

export const WEBHOOK_RECORD_RETENTION_MS = 48 * 60 * 60 * 1000;
export const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;

export interface CapturedResponse {
  bytes: Uint8Array;
  contentType: string | null;
  truncated: boolean;
  excerpt: string;
}

function redact(value: string): string {
  return value.replace(
    /(authorization|cookie|token|secret)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
}

export async function captureResponseBytes(
  response: Response,
  limit = MAX_WEBHOOK_RESPONSE_BYTES,
): Promise<CapturedResponse> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  if (reader) {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const remaining = limit - length;
        if (item.value.byteLength > remaining) {
          if (remaining > 0) chunks.push(item.value.slice(0, remaining));
          length += Math.max(remaining, 0);
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(item.value);
        length += item.value.byteLength;
      }
    } catch {
      truncated = true;
      await reader.cancel().catch(() => undefined);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const excerpt = redact(
    new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 1024))),
  );
  return {
    bytes,
    contentType: response.headers.get("Content-Type")?.slice(0, 255) ?? null,
    truncated,
    excerpt,
  };
}

export function snapshotObjectKeys(id: string): {
  payload: string;
  raw: string;
} {
  return {
    payload: `webhook-records/requests/${id}/payload.json`,
    raw: `webhook-records/requests/${id}/raw.eml`,
  };
}

export function responseObjectKey(id: string): string {
  return `webhook-records/responses/${id}.body`;
}

export async function registerRequestSnapshot(
  env: Env,
  input: {
    id: string;
    deliveryId: string | null;
    rawFilename: string;
    payloadSize: number;
    rawSize: number;
  },
  timestamp: number,
): Promise<void> {
  const keys = snapshotObjectKeys(input.id);
  await env.DB.prepare(
    "INSERT INTO webhook_request_snapshots(id,delivery_id,payload_object_key,raw_object_key,raw_filename,payload_size_bytes,raw_size_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)",
  )
    .bind(
      input.id,
      input.deliveryId,
      keys.payload,
      keys.raw,
      input.rawFilename,
      input.payloadSize,
      input.rawSize,
      timestamp,
      timestamp + WEBHOOK_RECORD_RETENTION_MS,
    )
    .run();
}

export async function captureRequestSnapshotFromKeys(
  env: Env,
  snapshotId: string,
  sourcePayloadKey: string,
  sourceRawKey: string,
  timestamp: number,
): Promise<void> {
  const keys = snapshotObjectKeys(snapshotId);
  try {
    const [payloadHead, rawHead] = await Promise.all([
      env.MAIL_STORAGE.head(keys.payload),
      env.MAIL_STORAGE.head(keys.raw),
    ]);
    if (payloadHead && rawHead) return;
    const [payload, raw] = await Promise.all([
      env.MAIL_STORAGE.get(sourcePayloadKey),
      env.MAIL_STORAGE.get(sourceRawKey),
    ]);
    if (!payload || !raw) throw new Error("SOURCE_OBJECT_MISSING");
    await Promise.all([
      payloadHead
        ? Promise.resolve()
        : env.MAIL_STORAGE.put(keys.payload, payload.body, {
            customMetadata: {
              kind: "webhook-record-payload",
              createdAt: String(timestamp),
            },
          }),
      rawHead
        ? Promise.resolve()
        : env.MAIL_STORAGE.put(keys.raw, raw.body, {
            customMetadata: {
              kind: "webhook-record-raw",
              createdAt: String(timestamp),
            },
          }),
    ]);
    await env.DB.prepare(
      "UPDATE webhook_request_snapshots SET capture_error_code=NULL WHERE id=?",
    )
      .bind(snapshotId)
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE webhook_request_snapshots SET capture_error_code=? WHERE id=?",
    )
      .bind(
        error instanceof Error ? error.message.slice(0, 80) : "CAPTURE_FAILED",
        snapshotId,
      )
      .run();
  }
}

export async function putRequestSnapshot(
  env: Env,
  snapshotId: string,
  payload: Uint8Array,
  raw: Uint8Array,
  timestamp: number,
): Promise<void> {
  const keys = snapshotObjectKeys(snapshotId);
  await Promise.all([
    env.MAIL_STORAGE.put(keys.payload, payload, {
      customMetadata: {
        kind: "webhook-record-payload",
        createdAt: String(timestamp),
      },
    }),
    env.MAIL_STORAGE.put(keys.raw, raw, {
      customMetadata: {
        kind: "webhook-record-raw",
        createdAt: String(timestamp),
      },
    }),
  ]);
}

export async function beginSendRecord(
  env: Env,
  input: {
    id: string;
    snapshotId: string;
    deliveryId: string | null;
    eventId: string;
    kind: "email" | "test";
    attemptNumber: number;
    endpointUrl: string;
  },
  timestamp: number,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO webhook_send_records(id,snapshot_id,delivery_id,event_id,kind,attempt_number,endpoint_url,started_at,result,expires_at) VALUES(?,?,?,?,?,?,?,?,'started',?)",
  )
    .bind(
      input.id,
      input.snapshotId,
      input.deliveryId,
      input.eventId,
      input.kind,
      input.attemptNumber,
      input.endpointUrl,
      timestamp,
      timestamp + WEBHOOK_RECORD_RETENTION_MS,
    )
    .run();
}

export async function finishSendRecord(
  env: Env,
  input: {
    id: string;
    finishedAt: number;
    result: "succeeded" | "retry" | "failed";
    httpStatus: number | null;
    durationMs: number;
    errorCode: string | null;
    requestHeaders: Record<string, string>;
    response: CapturedResponse | null;
  },
): Promise<void> {
  let objectKey: string | null = null;
  let responseCaptureFailed = false;
  if (input.response?.bytes.byteLength) {
    objectKey = responseObjectKey(input.id);
    try {
      await env.MAIL_STORAGE.put(objectKey, input.response.bytes, {
        httpMetadata: {
          contentType: input.response.contentType ?? "application/octet-stream",
        },
        customMetadata: {
          kind: "webhook-record-response",
          createdAt: String(input.finishedAt),
        },
      });
    } catch {
      objectKey = null;
      responseCaptureFailed = true;
    }
  }
  await env.DB.prepare(
    "UPDATE webhook_send_records SET request_headers_json=?,finished_at=?,result=?,http_status=?,duration_ms=?,error_code=?,response_object_key=?,response_content_type=?,response_captured_bytes=?,response_truncated=?,response_excerpt=?,expires_at=? WHERE id=?",
  )
    .bind(
      JSON.stringify(input.requestHeaders),
      input.finishedAt,
      input.result,
      input.httpStatus,
      input.durationMs,
      input.errorCode ?? (responseCaptureFailed ? "RESPONSE_CAPTURE_FAILED" : null),
      objectKey,
      input.response?.contentType ?? null,
      responseCaptureFailed ? 0 : (input.response?.bytes.byteLength ?? 0),
      input.response?.truncated ? 1 : 0,
      input.response?.excerpt ?? null,
      input.finishedAt + WEBHOOK_RECORD_RETENTION_MS,
      input.id,
    )
    .run();
  await env.DB.prepare(
    "UPDATE webhook_request_snapshots SET expires_at=MAX(expires_at,?) WHERE id=(SELECT snapshot_id FROM webhook_send_records WHERE id=?)",
  )
    .bind(input.finishedAt + WEBHOOK_RECORD_RETENTION_MS, input.id)
    .run();
}
