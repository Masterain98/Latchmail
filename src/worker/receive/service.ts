import type { Env } from "../env";
import { normalizeEnvelopeAddress } from "../../shared/normalization";
import { bytesToHex, sha256, uuid } from "../crypto";
import type { RegistrationSnapshot } from "../../shared/contracts";
import { runMaintenance } from "../maintenance/service";

interface DomainRow {
  id: string;
  domain_ascii: string;
}
interface SettingsRow {
  attachment_retention_days: number;
  webhook_enabled: number;
  webhook_url: string | null;
  webhook_revision: number;
}

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
  now = Date.now(),
): Promise<void> {
  let recipient: { address: string; domain: string };
  try {
    recipient = normalizeEnvelopeAddress(message.to);
  } catch {
    message.setReject("Invalid recipient address");
    return;
  }
  if (message.from.length > 1024 || message.to.length > 1024) {
    message.setReject("Address is too long");
    return;
  }
  const domain = await env.DB.prepare(
    "SELECT id,domain_ascii FROM domains WHERE domain_ascii=? AND enabled=1",
  )
    .bind(recipient.domain)
    .first<DomainRow>();
  if (!domain) {
    message.setReject("Domain is not enabled in Latchmail");
    return;
  }
  const settings = await env.DB.prepare(
    "SELECT attachment_retention_days,webhook_enabled,webhook_url,webhook_revision FROM app_settings WHERE singleton=1",
  ).first<SettingsRow>();
  if (!settings) throw new Error("SETTINGS_MISSING");
  const registration = await env.DB.prepare(
    "SELECT a.id,a.address_normalized,a.note,t.id tag_id,t.name tag_name FROM address_registry a LEFT JOIN tags t ON t.id=a.tag_id WHERE a.address_normalized=?",
  )
    .bind(recipient.address)
    .first<{
      id: string;
      address_normalized: string;
      note: string | null;
      tag_id: string | null;
      tag_name: string | null;
    }>();
  const snapshot: RegistrationSnapshot | null = registration
    ? {
        address_id: registration.id,
        address: registration.address_normalized,
        note: registration.note,
        tag: registration.tag_id
          ? { id: registration.tag_id, name: registration.tag_name! }
          : null,
      }
    : null;
  const id = uuid();
  const eventId = uuid();
  const rawKey = `raw/${new Date(now).toISOString().slice(0, 10)}/${id}.eml`;
  const fixed = new FixedLengthStream(message.rawSize);
  const piping = message.raw.pipeTo(fixed.writable);
  const [storage, hashing] = fixed.readable.tee();
  const digestConstructor = (
    globalThis as unknown as { DigestStream?: typeof DigestStream }
  ).DigestStream;
  let digestPromise: Promise<string>;
  if (digestConstructor) {
    const digest = new digestConstructor("SHA-256");
    digestPromise = hashing
      .pipeTo(digest)
      .then(async () => bytesToHex(await digest.digest));
  } else {
    digestPromise = new Response(hashing).arrayBuffer().then(sha256);
  }
  await Promise.all([
    env.MAIL_STORAGE.put(rawKey, storage, {
      customMetadata: {
        messageId: id,
        createdAt: String(now),
        expiresAt: String(now + settings.attachment_retention_days * 86400000),
      },
    }),
    piping,
  ]);
  const rawHash = await digestPromise;
  const expires = now + settings.attachment_retention_days * 86400000;
  const statements = [
    env.DB.prepare(
      "INSERT INTO messages(id,event_id,domain_id,received_at,envelope_from,envelope_to_original,envelope_to_normalized,raw_sha256,raw_size_bytes,raw_object_key,raw_expires_at,registration_snapshot_json,retention_days_snapshot,notification_requested,parse_state,parse_next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)",
    ).bind(
      id,
      eventId,
      domain.id,
      now,
      message.from,
      message.to,
      recipient.address,
      rawHash,
      message.rawSize,
      rawKey,
      expires,
      snapshot ? JSON.stringify(snapshot) : null,
      settings.attachment_retention_days,
      settings.webhook_enabled && settings.webhook_url ? 1 : 0,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO receive_dedup(envelope_from,envelope_to_normalized,raw_sha256,message_id,expires_at) VALUES(?,?,?,?,?)",
    ).bind(message.from, recipient.address, rawHash, id, now + 7 * 86400000),
    env.DB.prepare(
      "UPDATE domains SET last_received_at=?,updated_at=? WHERE id=?",
    ).bind(now, now, domain.id),
  ];
  if (settings.webhook_enabled && settings.webhook_url)
    statements.push(
      env.DB.prepare(
        "INSERT INTO webhook_deliveries(id,message_id,event_id,endpoint_url_snapshot,endpoint_revision,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'waiting_content',?,?,?)",
      ).bind(
        uuid(),
        id,
        eventId,
        settings.webhook_url,
        settings.webhook_revision,
        now,
        now,
        now,
      ),
    );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const duplicate = await env.DB.prepare(
      "SELECT message_id FROM receive_dedup WHERE envelope_from=? AND envelope_to_normalized=? AND raw_sha256=?",
    )
      .bind(message.from, recipient.address, rawHash)
      .first<{ message_id: string }>();
    const candidate = await env.DB.prepare("SELECT id FROM messages WHERE id=?")
      .bind(id)
      .first();
    if (duplicate && duplicate.message_id !== id && !candidate) {
      await env.MAIL_STORAGE.delete(rawKey);
      ctx.waitUntil(runMaintenance(env, Date.now()));
      return;
    }
    if (candidate) {
      ctx.waitUntil(runMaintenance(env, Date.now()));
      return;
    }
    throw error;
  }
  ctx.waitUntil(runMaintenance(env, Date.now()));
}
