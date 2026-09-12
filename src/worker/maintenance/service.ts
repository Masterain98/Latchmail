import type { Env } from "../env";
import { uuid } from "../crypto";
import {
  parseAndPublish,
  publishFailedPayload,
  type ParseMessageRow,
} from "../mail/payload";
import { processWebhookBatch } from "../webhooks/service";
import { WEBHOOK_RECORD_RETENTION_MS } from "../webhooks/records";

async function acquireGlobalLease(
  env: Env,
  name: string,
  now: number,
  duration: number,
): Promise<string | null> {
  const token = uuid();
  const result = await env.DB.prepare(
    "INSERT INTO job_leases(job_name,lease_token,lease_until) VALUES(?,?,?) ON CONFLICT(job_name) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until WHERE job_leases.lease_until<=?",
  )
    .bind(name, token, now + duration, now)
    .run();
  return Number(result.meta.changes) ? token : null;
}

async function releaseGlobalLease(
  env: Env,
  name: string,
  token: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM job_leases WHERE job_name=? AND lease_token=?",
  )
    .bind(name, token)
    .run();
}

export async function processOneMessage(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  const global = await acquireGlobalLease(env, "mime-parser", now, 120000);
  if (!global) return false;
  try {
    const candidate = await env.DB.prepare(
      "SELECT m.*,d.domain_ascii FROM messages m JOIN domains d ON d.id=m.domain_id WHERE m.deleted_at IS NULL AND m.raw_expires_at>? AND m.parse_attempts<3 AND ((m.parse_state='queued' AND COALESCE(m.parse_next_attempt_at,0)<=?) OR (m.parse_state='processing' AND m.parse_lease_until<=?)) ORDER BY m.received_at LIMIT 1",
    )
      .bind(now, now, now)
      .first<ParseMessageRow>();
    if (!candidate) return false;
    const lease = uuid();
    const claim = await env.DB.prepare(
      "UPDATE messages SET parse_state='processing',parse_attempts=parse_attempts+1,parse_lease_token=?,parse_lease_until=?,updated_at=? WHERE id=? AND ((parse_state='queued' AND COALESCE(parse_next_attempt_at,0)<=?) OR (parse_state='processing' AND parse_lease_until<=?))",
    )
      .bind(lease, now + 120000, now, candidate.id, now, now)
      .run();
    if (!Number(claim.meta.changes)) return false;
    candidate.parse_lease_token = lease;
    candidate.parse_attempts += 1;
    try {
      await parseAndPublish(env, candidate, now);
    } catch (error) {
      const code =
        error instanceof Error ? error.message.slice(0, 80) : "PARSE_ERROR";
      if (candidate.parse_attempts >= 3 || code === "RAW_MISSING")
        await publishFailedPayload(env, candidate, code, now);
      else
        await env.DB.prepare(
          "UPDATE messages SET parse_state='queued',parse_next_attempt_at=?,parse_error_code=?,parse_lease_token=NULL,parse_lease_until=NULL,updated_at=? WHERE id=? AND parse_lease_token=?",
        )
          .bind(
            now + candidate.parse_attempts * 60000,
            code,
            now,
            candidate.id,
            lease,
          )
          .run();
    }
    return true;
  } finally {
    await releaseGlobalLease(env, "mime-parser", global);
  }
}

async function cleanupExpired(
  env: Env,
  now: number,
  limit = 20,
): Promise<number> {
  let count = 0;
  const attachments = await env.DB.prepare(
    "SELECT id,object_key FROM attachments WHERE expires_at<=? AND state IN ('available','deleting') AND (cleanup_next_attempt_at IS NULL OR cleanup_next_attempt_at<=?) ORDER BY expires_at LIMIT ?",
  )
    .bind(now, now, limit)
    .all<{ id: string; object_key: string }>();
  for (const item of attachments.results) {
    await env.DB.prepare(
      "UPDATE attachments SET state='deleting',cleanup_attempts=cleanup_attempts+1 WHERE id=? AND state IN ('available','deleting')",
    )
      .bind(item.id)
      .run();
    try {
      await env.MAIL_STORAGE.delete(item.object_key);
      await env.DB.prepare(
        "UPDATE attachments SET state='deleted',deleted_at=?,cleanup_error_code=NULL WHERE id=?",
      )
        .bind(now, item.id)
        .run();
      count++;
    } catch {
      await env.DB.prepare(
        "UPDATE attachments SET state='deleting',cleanup_error_code='R2_DELETE_FAILED',cleanup_next_attempt_at=? WHERE id=?",
      )
        .bind(now + 3600000, item.id)
        .run();
    }
  }
  const raws = await env.DB.prepare(
    "SELECT m.id,m.raw_object_key FROM messages m WHERE m.raw_expires_at<=? AND m.raw_state IN ('available','deleting') AND NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.message_id=m.id AND d.status='inflight' AND d.lease_until>?) ORDER BY m.raw_expires_at LIMIT ?",
  )
    .bind(now, now, limit)
    .all<{ id: string; raw_object_key: string }>();
  for (const item of raws.results) {
    await env.DB.prepare(
      "UPDATE messages SET raw_state='deleting' WHERE id=? AND raw_state IN ('available','deleting')",
    )
      .bind(item.id)
      .run();
    try {
      await env.MAIL_STORAGE.delete(item.raw_object_key);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE messages SET raw_state='deleted',raw_deleted_at=?,updated_at=? WHERE id=?",
        ).bind(now, now, item.id),
        env.DB.prepare(
          "UPDATE webhook_deliveries SET status='expired',last_error_code='CONTENT_EXPIRED',updated_at=? WHERE message_id=? AND status NOT IN ('succeeded','failed','expired','canceled')",
        ).bind(now, item.id),
      ]);
      count++;
    } catch {
      await env.DB.prepare(
        "UPDATE messages SET raw_state='deleting',updated_at=? WHERE id=?",
      )
        .bind(now, item.id)
        .run();
    }
  }
  return count;
}

async function purgeDeleted(
  env: Env,
  now: number,
  limit = 10,
): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id,raw_object_key,content_object_key FROM messages WHERE deleted_at IS NOT NULL AND purge_state IN ('queued','failed') LIMIT ?",
  )
    .bind(limit)
    .all<{
      id: string;
      raw_object_key: string;
      content_object_key: string | null;
    }>();
  for (const row of rows.results) {
    await env.DB.prepare(
      "UPDATE messages SET purge_state='processing' WHERE id=?",
    )
      .bind(row.id)
      .run();
    try {
      const objects = await env.DB.prepare(
        "SELECT object_key FROM attachments WHERE message_id=?",
      )
        .bind(row.id)
        .all<{ object_key: string }>();
      await Promise.all([
        env.MAIL_STORAGE.delete(row.raw_object_key),
        row.content_object_key
          ? env.MAIL_STORAGE.delete(row.content_object_key)
          : Promise.resolve(),
        ...objects.results.map((item) =>
          env.MAIL_STORAGE.delete(item.object_key),
        ),
      ]);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE attachments SET state='deleted',deleted_at=? WHERE message_id=?",
        ).bind(now, row.id),
        env.DB.prepare(
          "UPDATE messages SET raw_state='deleted',raw_deleted_at=?,content_object_key=NULL,purge_state='complete',updated_at=? WHERE id=?",
        ).bind(now, now, row.id),
      ]);
    } catch {
      await env.DB.prepare(
        "UPDATE messages SET purge_state='failed',updated_at=? WHERE id=?",
      )
        .bind(now, row.id)
        .run();
    }
  }
  return rows.results.length;
}

async function cleanupWebhookRecords(
  env: Env,
  now: number,
  limit = 20,
): Promise<void> {
  const records = await env.DB.prepare(
    "SELECT id,response_object_key FROM webhook_send_records WHERE expires_at<=? AND (cleanup_next_attempt_at IS NULL OR cleanup_next_attempt_at<=?) ORDER BY expires_at LIMIT ?",
  )
    .bind(now, now, limit)
    .all<{ id: string; response_object_key: string | null }>();
  for (const record of records.results) {
    try {
      if (record.response_object_key)
        await env.MAIL_STORAGE.delete(record.response_object_key);
      await env.DB.prepare("DELETE FROM webhook_send_records WHERE id=?")
        .bind(record.id)
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE webhook_send_records SET cleanup_attempts=cleanup_attempts+1,cleanup_error_code='R2_DELETE_FAILED',cleanup_next_attempt_at=? WHERE id=?",
      )
        .bind(now + 3600000, record.id)
        .run();
    }
  }
  const snapshots = await env.DB.prepare(
    "SELECT id,payload_object_key,raw_object_key FROM webhook_request_snapshots s WHERE s.expires_at<=? AND (s.cleanup_next_attempt_at IS NULL OR s.cleanup_next_attempt_at<=?) AND NOT EXISTS(SELECT 1 FROM webhook_send_records r WHERE r.snapshot_id=s.id) ORDER BY s.expires_at LIMIT ?",
  )
    .bind(now, now, limit)
    .all<{
      id: string;
      payload_object_key: string;
      raw_object_key: string;
    }>();
  for (const snapshot of snapshots.results) {
    try {
      await Promise.all([
        env.MAIL_STORAGE.delete(snapshot.payload_object_key),
        env.MAIL_STORAGE.delete(snapshot.raw_object_key),
      ]);
      await env.DB.prepare("DELETE FROM webhook_request_snapshots WHERE id=?")
        .bind(snapshot.id)
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE webhook_request_snapshots SET cleanup_attempts=cleanup_attempts+1,cleanup_error_code='R2_DELETE_FAILED',cleanup_next_attempt_at=? WHERE id=?",
      )
        .bind(now + 3600000, snapshot.id)
        .run();
    }
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM webhook_attempts WHERE COALESCE(finished_at,started_at)<?",
    ).bind(now - WEBHOOK_RECORD_RETENTION_MS),
    env.DB.prepare(
      "DELETE FROM webhook_deliveries WHERE status IN ('succeeded','failed','expired','canceled') AND updated_at<?",
    ).bind(now - WEBHOOK_RECORD_RETENTION_MS),
  ]);
}

async function prune(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM receive_dedup WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM auth_rate_limits WHERE expires_at<=?").bind(
      now,
    ),
  ]);
}

async function scanOrphanObjects(
  env: Env,
  now: number,
  limit = 50,
): Promise<number> {
  const last = await env.DB.prepare(
    "SELECT value_int,value_text FROM maintenance_state WHERE key='orphan_scan'",
  ).first<{ value_int: number | null; value_text: string | null }>();
  if (!last?.value_text && (last?.value_int ?? 0) > now - 86400000) return 0;
  const listed = await env.MAIL_STORAGE.list({
    cursor: last?.value_text ?? undefined,
    limit,
    include: ["customMetadata"],
  });
  let deleted = 0;
  for (const object of listed.objects) {
    const createdAt = Number(object.customMetadata?.createdAt ?? NaN);
    if (!Number.isFinite(createdAt) || createdAt > now - 86400000) continue;
    const referenced = await env.DB.prepare(
      "SELECT 1 referenced FROM messages m WHERE (m.raw_object_key=? AND m.purge_state!='complete') OR m.content_object_key=? UNION ALL SELECT 1 FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.object_key=? AND a.parse_run_id=m.active_parse_run_id AND m.deleted_at IS NULL UNION ALL SELECT 1 FROM webhook_request_snapshots s WHERE s.payload_object_key=? OR s.raw_object_key=? UNION ALL SELECT 1 FROM webhook_send_records r WHERE r.response_object_key=? LIMIT 1",
    )
      .bind(
        object.key,
        object.key,
        object.key,
        object.key,
        object.key,
        object.key,
      )
      .first();
    if (!referenced) {
      await env.MAIL_STORAGE.delete(object.key);
      await env.DB.prepare(
        "UPDATE attachments SET state='deleted',deleted_at=COALESCE(deleted_at,?),cleanup_error_code='ORPHAN_RECLAIMED' WHERE object_key=?",
      )
        .bind(now, object.key)
        .run();
      deleted++;
    }
  }
  await env.DB.prepare(
    "INSERT INTO maintenance_state(key,value_text,value_int,updated_at) VALUES('orphan_scan',?,?,?) ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text,value_int=excluded.value_int,updated_at=excluded.updated_at",
  )
    .bind(
      listed.truncated ? listed.cursor : null,
      listed.truncated ? (last?.value_int ?? 0) : now,
      now,
    )
    .run();
  return deleted;
}

export async function runMaintenance(
  env: Env,
  now = Date.now(),
): Promise<{
  parsed: boolean;
  delivered: number;
  cleaned: number;
  purged: number;
  orphans: number;
}> {
  const parsed = await processOneMessage(env, now);
  const delivered = await processWebhookBatch(env, now, 2);
  const last = await env.DB.prepare(
    "SELECT value_int FROM maintenance_state WHERE key='last_cleanup_at'",
  ).first<{ value_int: number }>();
  let cleaned = 0;
  if (!last || last.value_int <= now - 3600000) {
    cleaned = await cleanupExpired(env, now);
    await cleanupWebhookRecords(env, now);
    await env.DB.prepare(
      "INSERT INTO maintenance_state(key,value_int,updated_at) VALUES('last_cleanup_at',?,?) ON CONFLICT(key) DO UPDATE SET value_int=excluded.value_int,updated_at=excluded.updated_at",
    )
      .bind(now, now)
      .run();
  }
  const purged = await purgeDeleted(env, now);
  const orphans = await scanOrphanObjects(env, now);
  await prune(env, now);
  await env.DB.prepare(
    "INSERT INTO maintenance_state(key,value_int,updated_at) VALUES('last_scheduled_at',?,?) ON CONFLICT(key) DO UPDATE SET value_int=excluded.value_int,updated_at=excluded.updated_at",
  )
    .bind(now, now)
    .run();
  return { parsed, delivered, cleaned, purged, orphans };
}
