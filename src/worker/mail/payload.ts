import PostalMime, { type Address, type Email } from "postal-mime";
import type {
  MailAddress,
  RegistrationSnapshot,
  WebhookPayload,
} from "../../shared/contracts";
import { sha256, uuid } from "../crypto";
import { safeDownloadName } from "../../shared/normalization";
import type { Env } from "../env";

export interface ParseMessageRow {
  id: string;
  event_id: string;
  domain_ascii: string;
  received_at: number;
  envelope_from: string;
  envelope_to_original: string;
  envelope_to_normalized: string;
  raw_sha256: string;
  raw_size_bytes: number;
  raw_object_key: string;
  raw_expires_at: number;
  registration_snapshot_json: string | null;
  parse_lease_token: string;
  parse_attempts: number;
}

function flatten(values: Address[] | undefined): MailAddress[] | null {
  if (!values) return null;
  const result: MailAddress[] = [];
  for (const value of values) {
    if ("group" in value && value.group)
      result.push(
        ...value.group.map((mailbox) => ({
          address: mailbox.address,
          name: mailbox.name || null,
        })),
      );
    else if ("address" in value && value.address)
      result.push({ address: value.address, name: value.name || null });
  }
  return result;
}

function single(value: Address | undefined): MailAddress | null {
  return flatten(value ? [value] : undefined)?.[0] ?? null;
}

function bytes(
  value: ArrayBuffer | Uint8Array | string,
): Uint8Array<ArrayBuffer> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return value instanceof Uint8Array
    ? Uint8Array.from(value)
    : new Uint8Array(value);
}

export async function parseAndPublish(
  env: Env,
  message: ParseMessageRow,
  now: number,
): Promise<void> {
  const raw = await env.MAIL_STORAGE.get(message.raw_object_key);
  if (!raw) throw new Error("RAW_MISSING");
  const parsed = await PostalMime.parse(await raw.arrayBuffer(), {
    attachmentEncoding: "arraybuffer",
    maxNestingDepth: 20,
    maxRfc822NestingDepth: 3,
    maxHeadersSize: 256 * 1024,
  });
  const parseRunId = uuid();
  const attachmentRows: Array<{
    id: string;
    index: number;
    key: string;
    filename: string;
    original: string | null;
    contentType: string;
    disposition: string | null;
    contentId: string | null;
    size: number;
    hash: string;
  }> = [];
  for (let index = 0; index < parsed.attachments.length; index++) {
    const attachment = parsed.attachments[index]!;
    const id = uuid();
    const content = bytes(attachment.content);
    const key = `attachments/${message.id}/${parseRunId}/${id}`;
    const hash = await sha256(content);
    await env.MAIL_STORAGE.put(key, content, {
      customMetadata: {
        messageId: message.id,
        createdAt: String(now),
        expiresAt: String(message.raw_expires_at),
        parseRunId,
      },
    });
    attachmentRows.push({
      id,
      index,
      key,
      filename: safeDownloadName(
        attachment.filename,
        `attachment-${index + 1}.bin`,
      ),
      original: attachment.filename,
      contentType: attachment.mimeType || "application/octet-stream",
      disposition: attachment.disposition,
      contentId: attachment.contentId ?? null,
      size: content.byteLength,
      hash,
    });
  }
  const registration = message.registration_snapshot_json
    ? (JSON.parse(message.registration_snapshot_json) as RegistrationSnapshot)
    : null;
  const payload: WebhookPayload = {
    schema_version: "1.0",
    event: "email.received",
    event_id: message.event_id,
    occurred_at: new Date(message.received_at).toISOString(),
    data: {
      message_id: message.id,
      domain: message.domain_ascii,
      received_at: new Date(message.received_at).toISOString(),
      envelope: {
        from: message.envelope_from,
        to: message.envelope_to_original,
        to_normalized: message.envelope_to_normalized,
      },
      registration,
      parse_status: "ready",
      parse_error: null,
      headers: parsed.headers.map((header) => ({
        name: header.originalKey,
        value: header.value,
      })),
      rfc_message_id: parsed.messageId ?? null,
      from: single(parsed.from),
      to: flatten(parsed.to),
      cc: flatten(parsed.cc),
      reply_to: flatten(parsed.replyTo),
      bcc_observed: flatten(parsed.bcc) ?? [],
      subject: parsed.subject ?? null,
      text: parsed.text ?? null,
      html: parsed.html ?? null,
      attachments: attachmentRows.map((item) => ({
        id: item.id,
        filename: item.original ?? item.filename,
        content_type: item.contentType,
        disposition: item.disposition,
        content_id: item.contentId,
        size_bytes: item.size,
        sha256: item.hash,
        expires_at: new Date(message.raw_expires_at).toISOString(),
      })),
      raw_email: {
        part_name: "raw_email",
        filename: `${message.id}.eml`,
        content_type: "message/rfc822",
        size_bytes: message.raw_size_bytes,
        sha256: message.raw_sha256,
        expires_at: new Date(message.raw_expires_at).toISOString(),
      },
    },
  };
  await publishPayload(
    env,
    message,
    parseRunId,
    parsed,
    payload,
    attachmentRows,
    now,
  );
}

async function publishPayload(
  env: Env,
  message: ParseMessageRow,
  parseRunId: string,
  parsed: Email,
  payload: WebhookPayload,
  attachments: Array<{
    id: string;
    index: number;
    key: string;
    filename: string;
    original: string | null;
    contentType: string;
    disposition: string | null;
    contentId: string | null;
    size: number;
    hash: string;
  }>,
  now: number,
): Promise<void> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadHash = await sha256(payloadBytes);
  const contentKey = `content/${message.id}/${parseRunId}/payload.json`;
  await env.MAIL_STORAGE.put(contentKey, payloadBytes, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      messageId: message.id,
      createdAt: String(now),
      parseRunId,
    },
  });
  const statements: D1PreparedStatement[] = attachments.map((item) =>
    env.DB.prepare(
      "INSERT INTO attachments(id,message_id,parse_run_id,part_index,object_key,filename_original,filename_download,content_type,disposition,content_id,size_bytes,sha256,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'available')",
    ).bind(
      item.id,
      message.id,
      parseRunId,
      item.index,
      item.key,
      item.original,
      item.filename,
      item.contentType,
      item.disposition,
      item.contentId,
      item.size,
      item.hash,
      message.raw_expires_at,
    ),
  );
  const subject = (parsed.subject ?? "").slice(0, 2048);
  const from = (single(parsed.from)?.address ?? message.envelope_from).slice(
    0,
    1024,
  );
  const snippet = (parsed.text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1024);
  statements.push(
    env.DB.prepare(
      "UPDATE messages SET content_object_key=?,content_sha256=?,content_size_bytes=?,active_parse_run_id=?,subject_preview=?,from_preview=?,message_id_header=?,snippet=?,attachment_count=?,parse_state='ready',parse_lease_token=NULL,parse_lease_until=NULL,parse_error_code=NULL,updated_at=? WHERE id=? AND parse_lease_token=? AND deleted_at IS NULL AND raw_expires_at>?",
    ).bind(
      contentKey,
      payloadHash,
      payloadBytes.byteLength,
      parseRunId,
      subject || null,
      from || null,
      parsed.messageId?.slice(0, 1024) ?? null,
      snippet || null,
      attachments.length,
      now,
      message.id,
      message.parse_lease_token,
      now,
    ),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE webhook_deliveries SET status='pending',next_attempt_at=?,updated_at=? WHERE message_id=? AND status='waiting_content' AND EXISTS(SELECT 1 FROM messages m WHERE m.id=? AND m.active_parse_run_id=? AND m.deleted_at IS NULL)",
    ).bind(now, now, message.id, message.id, parseRunId),
  );
  await env.DB.batch(statements);
  const published = await env.DB.prepare(
    "SELECT active_parse_run_id FROM messages WHERE id=?",
  )
    .bind(message.id)
    .first<{ active_parse_run_id: string | null }>();
  if (published?.active_parse_run_id !== parseRunId)
    throw new Error("STALE_PARSE_LEASE");
}

export async function publishFailedPayload(
  env: Env,
  message: ParseMessageRow,
  errorCode: string,
  now: number,
): Promise<void> {
  const payload: WebhookPayload = {
    schema_version: "1.0",
    event: "email.received",
    event_id: message.event_id,
    occurred_at: new Date(message.received_at).toISOString(),
    data: {
      message_id: message.id,
      domain: message.domain_ascii,
      received_at: new Date(message.received_at).toISOString(),
      envelope: {
        from: message.envelope_from,
        to: message.envelope_to_original,
        to_normalized: message.envelope_to_normalized,
      },
      registration: message.registration_snapshot_json
        ? (JSON.parse(
            message.registration_snapshot_json,
          ) as RegistrationSnapshot)
        : null,
      parse_status: "failed",
      parse_error: errorCode,
      headers: null,
      rfc_message_id: null,
      from: null,
      to: null,
      cc: null,
      reply_to: null,
      bcc_observed: [],
      subject: null,
      text: null,
      html: null,
      attachments: null,
      raw_email: {
        part_name: "raw_email",
        filename: `${message.id}.eml`,
        content_type: "message/rfc822",
        size_bytes: message.raw_size_bytes,
        sha256: message.raw_sha256,
        expires_at: new Date(message.raw_expires_at).toISOString(),
      },
    },
  };
  const parseRunId = uuid();
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const hash = await sha256(encoded);
  const key = `content/${message.id}/${parseRunId}/payload.json`;
  await env.MAIL_STORAGE.put(key, encoded, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      messageId: message.id,
      createdAt: String(now),
      parseRunId,
    },
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET content_object_key=?,content_sha256=?,content_size_bytes=?,active_parse_run_id=?,parse_state='failed',parse_error_code=?,parse_lease_token=NULL,parse_lease_until=NULL,updated_at=? WHERE id=? AND parse_lease_token=?",
    ).bind(
      key,
      hash,
      encoded.byteLength,
      parseRunId,
      errorCode,
      now,
      message.id,
      message.parse_lease_token,
    ),
    env.DB.prepare(
      "UPDATE webhook_deliveries SET status='pending',next_attempt_at=?,updated_at=? WHERE message_id=? AND status='waiting_content'",
    ).bind(now, now, message.id),
  ]);
}
