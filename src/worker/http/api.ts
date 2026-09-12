import { Hono } from "hono";
import { clearSessionCookie } from "../auth/session";
import { login } from "../auth/login";
import type { Env, WorkerContext } from "../env";
import {
  addressCreateSchema,
  addressPatchSchema,
  domainCreateSchema,
  domainPatchSchema,
  messagePatchSchema,
  settingsPatchSchema,
  tagCreateSchema,
  webhookPutSchema,
} from "../../shared/contracts";
import { AppError } from "../../shared/errors";
import {
  normalizeDomain,
  normalizeLocalPart,
  normalizeTag,
  safeDownloadName,
} from "../../shared/normalization";
import { iso, required } from "../repositories/db";
import { sha256, uuid } from "../crypto";
import { runMaintenance } from "../maintenance/service";
import { sendWebhookParts } from "../webhooks/service";
import {
  beginSendRecord,
  captureResponseBytes,
  finishSendRecord,
  putRequestSnapshot,
  registerRequestSnapshot,
  snapshotObjectKeys,
} from "../webhooks/records";

type AppBindings = { Bindings: Env; Variables: { worker: WorkerContext } };
export const api = new Hono<AppBindings>();
const ok = (c: any, data: unknown, status = 200) => c.json({ data }, status);
const now = () => Date.now();

async function body<T>(
  c: any,
  schema: { parse(value: unknown): T },
): Promise<T> {
  return schema.parse(await c.req.json());
}
function pageLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
    throw new AppError(400, "BAD_REQUEST", "limit 应为 1～100 的整数。");
  return parsed;
}
function cursorEncode(received: number, id: string): string {
  return btoa(JSON.stringify([received, id]));
}
function cursorDecode(value: string): [number, string] {
  try {
    const parsed = JSON.parse(atob(value));
    if (
      !Array.isArray(parsed) ||
      !Number.isFinite(parsed[0]) ||
      typeof parsed[1] !== "string"
    )
      throw new Error();
    return [parsed[0], parsed[1]];
  } catch {
    throw new AppError(400, "BAD_REQUEST", "游标无效。");
  }
}

api.post("/auth/login", login);
api.post("/auth/logout", (c) => {
  clearSessionCookie(c);
  return ok(c, { authenticated: false });
});
api.get("/auth/session", (c) =>
  ok(c, {
    authenticated: true,
    csrf: c.get("worker").csrf ?? null,
    auth_mode: c.get("worker").authMode,
  }),
);

api.get("/domains", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT d.*,COUNT(DISTINCT a.id) address_count,COUNT(DISTINCT m.id) message_count FROM domains d LEFT JOIN address_registry a ON a.domain_id=d.id LEFT JOIN messages m ON m.domain_id=d.id AND m.deleted_at IS NULL GROUP BY d.id ORDER BY d.created_at",
  ).all<any>();
  return ok(
    c,
    rows.results.map((r) => ({
      ...r,
      enabled: Boolean(r.enabled),
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      last_received_at: iso(r.last_received_at),
    })),
  );
});
api.post("/domains", async (c) => {
  const input = await body(c, domainCreateSchema);
  const timestamp = now();
  const id = uuid();
  const domain = normalizeDomain(input.domain);
  try {
    await c.env.DB.prepare(
      "INSERT INTO domains(id,domain_ascii,display_name,note,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        domain,
        input.domain.trim().replace(/\.$/, ""),
        input.note ?? null,
        input.enabled ? 1 : 0,
        timestamp,
        timestamp,
      )
      .run();
  } catch {
    throw new AppError(409, "CONFLICT", "该域名已登记。");
  }
  return ok(c, { id, domain_ascii: domain }, 201);
});
api.patch("/domains/:id", async (c) => {
  const input = await body(c, domainPatchSchema);
  const current = await required<any>(
    c.env.DB.prepare("SELECT * FROM domains WHERE id=?").bind(
      c.req.param("id"),
    ),
  );
  await c.env.DB.prepare(
    "UPDATE domains SET note=?,enabled=?,updated_at=? WHERE id=?",
  )
    .bind(
      input.note === undefined ? current.note : input.note,
      input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      now(),
      current.id,
    )
    .run();
  return ok(c, { id: current.id });
});

api.get("/tags", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT t.*,COUNT(a.id) address_count FROM tags t LEFT JOIN address_registry a ON a.tag_id=t.id GROUP BY t.id ORDER BY t.name_normalized",
  ).all<any>();
  return ok(
    c,
    rows.results.map((r) => ({
      ...r,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    })),
  );
});
api.post("/tags", async (c) => {
  const input = await body(c, tagCreateSchema);
  const tag = normalizeTag(input.name);
  const id = uuid(),
    timestamp = now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO tags(id,name,name_normalized,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
      .bind(id, tag.name, tag.key, timestamp, timestamp)
      .run();
  } catch {
    throw new AppError(409, "CONFLICT", "标签名称已存在。");
  }
  return ok(c, { id, name: tag.name }, 201);
});
api.patch("/tags/:id", async (c) => {
  const input = await body(c, tagCreateSchema);
  const tag = normalizeTag(input.name);
  try {
    const result = await c.env.DB.prepare(
      "UPDATE tags SET name=?,name_normalized=?,updated_at=? WHERE id=?",
    )
      .bind(tag.name, tag.key, now(), c.req.param("id"))
      .run();
    if (!Number(result.meta.changes))
      throw new AppError(404, "NOT_FOUND", "标签不存在。");
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(409, "CONFLICT", "标签名称已存在。");
  }
  return ok(c, { id: c.req.param("id"), name: tag.name });
});
api.delete("/tags/:id", async (c) => {
  const id = c.req.param("id");
  const used = await c.env.DB.prepare(
    "SELECT 1 used FROM address_registry WHERE tag_id=? LIMIT 1",
  )
    .bind(id)
    .first();
  if (used) throw new AppError(409, "CONFLICT", "请先解除地址对该标签的引用。");
  const result = await c.env.DB.prepare("DELETE FROM tags WHERE id=?")
    .bind(id)
    .run();
  if (!Number(result.meta.changes))
    throw new AppError(404, "NOT_FOUND", "标签不存在。");
  return ok(c, { deleted: true });
});

api.get("/addresses", async (c) => {
  const limit = pageLimit(c.req.query("limit"));
  const where: string[] = [];
  const values: unknown[] = [];
  if (c.req.query("domain_id")) {
    where.push("a.domain_id=?");
    values.push(c.req.query("domain_id"));
  }
  if (c.req.query("tag_id")) {
    where.push("a.tag_id=?");
    values.push(c.req.query("tag_id"));
  }
  const sql = `SELECT a.*,d.domain_ascii,t.name tag_name,(SELECT MAX(received_at) FROM messages m WHERE m.envelope_to_normalized=a.address_normalized AND m.deleted_at IS NULL) last_received_at FROM address_registry a JOIN domains d ON d.id=a.domain_id LEFT JOIN tags t ON t.id=a.tag_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.created_at DESC LIMIT ?`;
  values.push(limit);
  const rows = await c.env.DB.prepare(sql)
    .bind(...values)
    .all<any>();
  return ok(
    c,
    rows.results.map((r) => ({
      ...r,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      last_received_at: iso(r.last_received_at),
    })),
  );
});
api.post("/addresses", async (c) => {
  const input = await body(c, addressCreateSchema);
  const domain = await required<{ domain_ascii: string }>(
    c.env.DB.prepare("SELECT domain_ascii FROM domains WHERE id=?").bind(
      input.domain_id,
    ),
    "域名不存在。",
  );
  if (input.tag_id)
    await required(
      c.env.DB.prepare("SELECT id FROM tags WHERE id=?").bind(input.tag_id),
      "标签不存在。",
    );
  const local = normalizeLocalPart(input.local_part),
    address = `${local}@${domain.domain_ascii}`,
    id = uuid(),
    timestamp = now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO address_registry(id,domain_id,local_part,address_normalized,tag_id,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        input.domain_id,
        local,
        address,
        input.tag_id ?? null,
        input.note ?? null,
        timestamp,
        timestamp,
      )
      .run();
  } catch {
    throw new AppError(409, "CONFLICT", "该完整地址已登记。");
  }
  return ok(c, { id, address_normalized: address }, 201);
});
api.patch("/addresses/:id", async (c) => {
  const input = await body(c, addressPatchSchema);
  const current = await required<any>(
    c.env.DB.prepare("SELECT * FROM address_registry WHERE id=?").bind(
      c.req.param("id"),
    ),
    "地址登记不存在。",
  );
  if (input.tag_id)
    await required(
      c.env.DB.prepare("SELECT id FROM tags WHERE id=?").bind(input.tag_id),
      "标签不存在。",
    );
  await c.env.DB.prepare(
    "UPDATE address_registry SET tag_id=?,note=?,updated_at=? WHERE id=?",
  )
    .bind(
      input.tag_id === undefined ? current.tag_id : input.tag_id,
      input.note === undefined ? current.note : input.note,
      now(),
      current.id,
    )
    .run();
  return ok(c, { id: current.id });
});
api.delete("/addresses/:id", async (c) => {
  const result = await c.env.DB.prepare(
    "DELETE FROM address_registry WHERE id=?",
  )
    .bind(c.req.param("id"))
    .run();
  if (!Number(result.meta.changes))
    throw new AppError(404, "NOT_FOUND", "地址登记不存在。");
  return ok(c, { deleted: true });
});

api.get("/messages", async (c) => {
  const limit = pageLimit(c.req.query("limit"));
  const where = ["m.deleted_at IS NULL"];
  const values: unknown[] = [];
  const add = (query: string, column: string) => {
    const value = c.req.query(query);
    if (value) {
      where.push(`${column}=?`);
      values.push(value);
    }
  };
  add("domain_id", "m.domain_id");
  add("tag_id", "a.tag_id");
  add("recipient", "m.envelope_to_normalized");
  add("webhook_status", "wd.status");
  const archived = c.req.query("archived");
  if (archived !== undefined) {
    where.push("m.is_archived=?");
    values.push(archived === "true" ? 1 : 0);
  } else where.push("m.is_archived=0");
  if (c.req.query("unread") === "true") where.push("m.is_read=0");
  if (c.req.query("registered") === "false") where.push("a.id IS NULL");
  if (c.req.query("registered") === "true") where.push("a.id IS NOT NULL");
  if (c.req.query("untagged") === "true")
    where.push("a.id IS NOT NULL AND a.tag_id IS NULL");
  if (
    c.req.query("registered") === "false" &&
    c.req.query("untagged") === "true"
  )
    throw new AppError(
      400,
      "BAD_REQUEST",
      "未登记与已登记未打标签筛选不能同时使用。",
    );
  const q = c.req.query("q")?.trim();
  if (q) {
    if (new TextEncoder().encode(q).byteLength > 256)
      throw new AppError(400, "BAD_REQUEST", "搜索词过长。");
    where.push(
      "(instr(lower(COALESCE(m.subject_preview,'')),lower(?))>0 OR instr(lower(COALESCE(m.from_preview,'')),lower(?))>0 OR instr(lower(m.envelope_to_normalized),lower(?))>0 OR instr(lower(COALESCE(a.note,'')),lower(?))>0 OR instr(lower(COALESCE(t.name,'')),lower(?))>0)",
    );
    values.push(q, q, q, q, q);
  }
  const cursor = c.req.query("cursor");
  if (cursor) {
    const [received, id] = cursorDecode(cursor);
    where.push("(m.received_at<? OR (m.received_at=? AND m.id<?))");
    values.push(received, received, id);
  }
  const sql = `SELECT m.id,m.event_id,m.received_at,m.envelope_from,m.envelope_to_original,m.envelope_to_normalized,m.subject_preview,m.from_preview,m.snippet,m.attachment_count,m.is_read,m.is_archived,m.parse_state,m.parse_error_code,a.id address_id,a.note address_note,t.id tag_id,t.name tag_name,wd.status webhook_status FROM messages m LEFT JOIN address_registry a ON a.address_normalized=m.envelope_to_normalized LEFT JOIN tags t ON t.id=a.tag_id LEFT JOIN webhook_deliveries wd ON wd.id=(SELECT id FROM webhook_deliveries x WHERE x.message_id=m.id ORDER BY x.created_at DESC LIMIT 1) WHERE ${where.join(" AND ")} ORDER BY m.received_at DESC,m.id DESC LIMIT ?`;
  values.push(limit + 1);
  const rows = await c.env.DB.prepare(sql)
    .bind(...values)
    .all<any>();
  const hasMore = rows.results.length > limit;
  const selected = rows.results.slice(0, limit);
  const last = selected.at(-1);
  return c.json({
    data: selected.map((r) => ({
      ...r,
      is_read: Boolean(r.is_read),
      is_archived: Boolean(r.is_archived),
      received_at: iso(r.received_at),
      current_registration: r.address_id
        ? {
            id: r.address_id,
            note: r.address_note,
            tag: r.tag_id ? { id: r.tag_id, name: r.tag_name } : null,
          }
        : null,
    })),
    next_cursor:
      hasMore && last ? cursorEncode(last.received_at, last.id) : null,
  });
});
api.get("/messages/:id", async (c) => {
  const row = await required<any>(
    c.env.DB.prepare(
      "SELECT m.*,d.domain_ascii,a.id address_id,a.note address_note,t.id tag_id,t.name tag_name FROM messages m JOIN domains d ON d.id=m.domain_id LEFT JOIN address_registry a ON a.address_normalized=m.envelope_to_normalized LEFT JOIN tags t ON t.id=a.tag_id WHERE m.id=? AND m.deleted_at IS NULL",
    ).bind(c.req.param("id")),
    "邮件不存在。",
  );
  let content = null;
  if (row.content_object_key) {
    const object = await c.env.MAIL_STORAGE.get(row.content_object_key);
    if (object) content = await object.json();
  }
  const attachments = await c.env.DB.prepare(
    "SELECT id,filename_original,filename_download,content_type,disposition,content_id,size_bytes,sha256,expires_at,state FROM attachments WHERE message_id=? AND parse_run_id=? ORDER BY part_index",
  )
    .bind(row.id, row.active_parse_run_id)
    .all<any>();
  const deliveries = await c.env.DB.prepare(
    "SELECT id,status,attempts_total,last_http_status,last_error_code,delivered_at,updated_at FROM webhook_deliveries WHERE message_id=? ORDER BY created_at DESC",
  )
    .bind(row.id)
    .all<any>();
  return ok(c, {
    ...row,
    is_read: Boolean(row.is_read),
    is_archived: Boolean(row.is_archived),
    received_at: iso(row.received_at),
    raw_expires_at: iso(row.raw_expires_at),
    current_registration: row.address_id
      ? {
          id: row.address_id,
          note: row.address_note,
          tag: row.tag_id ? { id: row.tag_id, name: row.tag_name } : null,
        }
      : null,
    content,
    attachments: attachments.results.map((a) => ({
      ...a,
      expires_at: iso(a.expires_at),
      available: a.state === "available" && a.expires_at > now(),
    })),
    deliveries: deliveries.results.map((d) => ({
      ...d,
      delivered_at: iso(d.delivered_at),
      updated_at: iso(d.updated_at),
    })),
  });
});
api.patch("/messages/:id", async (c) => {
  const input = await body(c, messagePatchSchema);
  const current = await required<any>(
    c.env.DB.prepare(
      "SELECT is_read,is_archived FROM messages WHERE id=? AND deleted_at IS NULL",
    ).bind(c.req.param("id")),
    "邮件不存在。",
  );
  await c.env.DB.prepare(
    "UPDATE messages SET is_read=?,is_archived=?,updated_at=? WHERE id=?",
  )
    .bind(
      input.is_read === undefined ? current.is_read : input.is_read ? 1 : 0,
      input.is_archived === undefined
        ? current.is_archived
        : input.is_archived
          ? 1
          : 0,
      now(),
      c.req.param("id"),
    )
    .run();
  return ok(c, { id: c.req.param("id") });
});
api.delete("/messages/:id", async (c) => {
  const timestamp = now();
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE messages SET deleted_at=COALESCE(deleted_at,?),purge_state=CASE WHEN purge_state='complete' THEN 'complete' ELSE 'queued' END,updated_at=? WHERE id=?",
    ).bind(timestamp, timestamp, c.req.param("id")),
    c.env.DB.prepare(
      "UPDATE webhook_deliveries SET status='canceled',last_error_code='MESSAGE_DELETED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE message_id=? AND status NOT IN ('succeeded','failed','expired','canceled')",
    ).bind(timestamp, c.req.param("id")),
  ]);
  if (!Number(result[0]?.meta.changes))
    throw new AppError(404, "NOT_FOUND", "邮件不存在。");
  c.executionCtx.waitUntil(runMaintenance(c.env, timestamp));
  return ok(c, { deleted: true, purge_state: "queued" }, 202);
});

async function rawOrAttachment(
  c: any,
  type: "raw" | "attachment",
): Promise<Response> {
  const timestamp = now();
  if (type === "raw") {
    const row = await required<any>(
      c.env.DB.prepare(
        "SELECT id,raw_object_key,raw_expires_at,raw_state FROM messages WHERE id=? AND deleted_at IS NULL",
      ).bind(c.req.param("id")),
      "邮件不存在。",
    );
    if (row.raw_expires_at <= timestamp || row.raw_state !== "available")
      throw new AppError(410, "CONTENT_EXPIRED", "原始邮件已过期。");
    const object = await c.env.MAIL_STORAGE.get(row.raw_object_key);
    if (!object)
      throw new AppError(410, "CONTENT_EXPIRED", "原始邮件对象不可用。");
    return new Response(object.body, {
      headers: {
        "Content-Type": "message/rfc822",
        "Content-Disposition": `attachment; filename="${row.id}.eml"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  const row = await required<any>(
    c.env.DB.prepare(
      "SELECT a.*,m.deleted_at,m.active_parse_run_id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=? AND m.deleted_at IS NULL AND a.parse_run_id=m.active_parse_run_id",
    ).bind(c.req.param("id")),
    "附件不存在。",
  );
  if (row.expires_at <= timestamp || row.state !== "available")
    throw new AppError(410, "CONTENT_EXPIRED", "附件已过期。");
  const object = await c.env.MAIL_STORAGE.get(row.object_key);
  if (!object) throw new AppError(410, "CONTENT_EXPIRED", "附件对象不可用。");
  const filename = safeDownloadName(row.filename_download);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
api.get("/messages/:id/raw", (c) => rawOrAttachment(c, "raw"));
api.get("/attachments/:id/download", (c) => rawOrAttachment(c, "attachment"));

api.get("/settings", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT attachment_retention_days,updated_at FROM app_settings WHERE singleton=1",
  ).first<any>();
  return ok(c, { ...row, updated_at: iso(row?.updated_at) });
});
api.patch("/settings", async (c) => {
  const input = await body(c, settingsPatchSchema);
  await c.env.DB.prepare(
    "UPDATE app_settings SET attachment_retention_days=?,updated_at=? WHERE singleton=1",
  )
    .bind(input.attachment_retention_days, now())
    .run();
  return ok(c, {
    attachment_retention_days: input.attachment_retention_days,
    applies_to: "future_messages_only",
  });
});
api.get("/webhook", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT webhook_enabled,webhook_url,webhook_revision,updated_at FROM app_settings WHERE singleton=1",
  ).first<any>();
  return ok(c, {
    enabled: Boolean(row?.webhook_enabled),
    url: row?.webhook_url,
    revision: row?.webhook_revision,
    signing_secret_configured: Boolean(c.env.WEBHOOK_SIGNING_SECRET),
    updated_at: iso(row?.updated_at),
  });
});
function isBlockedNetworkHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:"))
    return isBlockedNetworkHost(normalized.slice("::ffff:".length));
  return (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "169.254.169.254" ||
    /^127\./.test(normalized) ||
    /^10\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^(fc|fd|fe[89ab]|ff)/.test(normalized)
  );
}
async function assertWebhookUrl(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "BAD_REQUEST", "Webhook URL 无效。");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new AppError(
      400,
      "BAD_REQUEST",
      "Webhook 必须使用无内嵌凭据的 HTTPS URL。",
    );
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedNetworkHost(host))
    throw new AppError(
      400,
      "BAD_REQUEST",
      "Webhook 目标不能指向本地、私网或元数据地址。",
    );
  if (!/^\d+(?:\.\d+){3}$/.test(host) && !host.includes(":")) {
    const answers = await Promise.all(
      ["A", "AAAA"].map(async (type) => {
        const endpoint = new URL("https://cloudflare-dns.com/dns-query");
        endpoint.searchParams.set("name", host);
        endpoint.searchParams.set("type", type);
        const response = await fetch(endpoint, {
          headers: { Accept: "application/dns-json" },
          redirect: "error",
        });
        if (!response.ok)
          throw new AppError(400, "BAD_REQUEST", "无法安全解析 Webhook 域名。");
        const result = (await response.json()) as {
          Answer?: Array<{ data: string }>;
        };
        return (result.Answer ?? []).map((answer) => answer.data);
      }),
    );
    const resolved = answers.flat();
    if (!resolved.length || resolved.some((address) => isBlockedNetworkHost(address)))
      throw new AppError(
        400,
        "BAD_REQUEST",
        "Webhook 域名解析到了不允许的网络地址。",
      );
  }
}
api.put("/webhook", async (c) => {
  const input = await body(c, webhookPutSchema);
  if (input.enabled && !input.url)
    throw new AppError(400, "BAD_REQUEST", "启用 Webhook 时必须设置 URL。");
  if (input.url) await assertWebhookUrl(input.url);
  const current = await c.env.DB.prepare(
    "SELECT * FROM app_settings WHERE singleton=1",
  ).first<any>();
  const changedUrl = (current?.webhook_url ?? null) !== (input.url ?? null);
  if (changedUrl && !input.confirm_cancel_pending)
    throw new AppError(
      409,
      "CONFLICT",
      "更换 URL 会取消旧目标的未完成任务，请确认。",
    );
  const revision = changedUrl
    ? Number(current.webhook_revision) + 1
    : Number(current.webhook_revision);
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE app_settings SET webhook_enabled=?,webhook_url=?,webhook_revision=?,updated_at=? WHERE singleton=1",
    ).bind(input.enabled ? 1 : 0, input.url, revision, timestamp),
    changedUrl
      ? c.env.DB.prepare(
          "UPDATE webhook_deliveries SET status='canceled',last_error_code='ENDPOINT_CHANGED',updated_at=? WHERE endpoint_revision<>? AND status NOT IN ('succeeded','failed','expired','canceled')",
        ).bind(timestamp, revision)
      : input.enabled
        ? c.env.DB.prepare(
            "UPDATE webhook_deliveries SET status=CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE m.id=message_id AND m.content_object_key IS NOT NULL) THEN 'pending' ELSE 'waiting_content' END,next_attempt_at=?,updated_at=? WHERE endpoint_revision=? AND status='paused'",
          ).bind(timestamp, timestamp, revision)
        : c.env.DB.prepare(
            "UPDATE webhook_deliveries SET status='paused',updated_at=? WHERE endpoint_revision=? AND status IN ('waiting_content','pending','retry_wait')",
          ).bind(timestamp, revision),
  ]);
  return ok(c, { enabled: input.enabled, url: input.url, revision });
});
api.post("/webhook/test", async (c) => {
  const settings = await c.env.DB.prepare(
    "SELECT webhook_enabled,webhook_url,webhook_revision FROM app_settings WHERE singleton=1",
  ).first<any>();
  if (!settings?.webhook_enabled || !settings.webhook_url)
    throw new AppError(409, "CONFLICT", "请先启用并保存 Webhook。");
  const eventId = uuid(),
    deliveryId = uuid(),
    recordId = uuid(),
    timestamp = now();
  const rawBytes = new TextEncoder().encode(
    `From: fixture@example.net\r\nTo: test@example.invalid\r\nSubject: Latchmail webhook test\r\nMessage-ID: <${eventId}@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThis is a synthetic Latchmail webhook test.\r\n`,
  );
  const rawHash = await sha256(rawBytes);
  const payload = {
    schema_version: "1.0",
    event: "webhook.test",
    event_id: eventId,
    occurred_at: new Date(timestamp).toISOString(),
    data: {
      message_id: deliveryId,
      domain: "example.invalid",
      received_at: new Date(timestamp).toISOString(),
      envelope: {
        from: "fixture@example.net",
        to: "test@example.invalid",
        to_normalized: "test@example.invalid",
      },
      registration: null,
      parse_status: "ready",
      parse_error: null,
      headers: [],
      rfc_message_id: `<${eventId}@example.invalid>`,
      from: { address: "fixture@example.net", name: null },
      to: [{ address: "test@example.invalid", name: null }],
      cc: [],
      reply_to: [],
      bcc_observed: [],
      subject: "Latchmail webhook test",
      text: "This is a synthetic Latchmail webhook test.\r\n",
      html: null,
      attachments: [],
      raw_email: {
        part_name: "raw_email",
        filename: `${deliveryId}.eml`,
        content_type: "message/rfc822",
        size_bytes: rawBytes.byteLength,
        sha256: rawHash,
        expires_at: new Date(timestamp + 86400000).toISOString(),
      },
    },
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)),
    payloadHash = await sha256(payloadBytes),
    snapshotId = recordId;
  await registerRequestSnapshot(
    c.env,
    {
      id: snapshotId,
      deliveryId: null,
      rawFilename: `${deliveryId}.eml`,
      payloadSize: payloadBytes.byteLength,
      rawSize: rawBytes.byteLength,
    },
    timestamp,
  );
  await putRequestSnapshot(
    c.env,
    snapshotId,
    payloadBytes,
    rawBytes,
    timestamp,
  );
  await beginSendRecord(
    c.env,
    {
      id: recordId,
      snapshotId,
      deliveryId,
      eventId,
      kind: "test",
      attemptNumber: 1,
      endpointUrl: settings.webhook_url,
    },
    timestamp,
  );
  const keys = snapshotObjectKeys(snapshotId);
  let requestHeaders: Record<string, string> = {};
  try {
    const [p, r] = await Promise.all([
      c.env.MAIL_STORAGE.get(keys.payload),
      c.env.MAIL_STORAGE.get(keys.raw),
    ]);
    if (!p || !r) throw new Error("TEST_OBJECT_MISSING");
    const response = await sendWebhookParts(
      c.env,
      {
        id: deliveryId,
        event_id: eventId,
        endpoint_url_snapshot: settings.webhook_url,
        content_sha256: payloadHash,
      },
      p,
      r,
      `${deliveryId}.eml`,
      timestamp,
      undefined,
      (headers) => {
        requestHeaders = headers;
      },
    );
    const finished = now();
    const captured = await captureResponseBytes(response);
    const accepted = response.status >= 200 && response.status < 300;
    await finishSendRecord(c.env, {
      id: recordId,
      finishedAt: finished,
      result: accepted ? "succeeded" : "failed",
      httpStatus: response.status,
      durationMs: finished - timestamp,
      errorCode: accepted ? null : `HTTP_${response.status}`,
      requestHeaders,
      response: captured,
    });
    return ok(c, {
      event_id: eventId,
      record_id: recordId,
      http_status: response.status,
      accepted,
    });
  } catch (error) {
    const finished = now();
    const errorCode =
      error instanceof Error ? error.message.slice(0, 80) : "NETWORK_ERROR";
    await finishSendRecord(c.env, {
      id: recordId,
      finishedAt: finished,
      result: "failed",
      httpStatus: null,
      durationMs: finished - timestamp,
      errorCode,
      requestHeaders,
      response: null,
    });
    throw error;
  }
});

const webhookRecordResults = new Set([
  "started",
  "succeeded",
  "retry",
  "failed",
  "interrupted",
]);
const webhookRecordKinds = new Set(["email", "test"]);

function webhookRecordJson(row: any): any {
  return {
    ...row,
    response_truncated: Boolean(row.response_truncated),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    expires_at: iso(row.expires_at),
  };
}

async function webhookRecord(c: any): Promise<any> {
  const row = await c.env.DB.prepare(
    "SELECT r.*,s.payload_object_key,s.raw_object_key,s.raw_filename,s.payload_size_bytes,s.raw_size_bytes,s.capture_error_code FROM webhook_send_records r JOIN webhook_request_snapshots s ON s.id=r.snapshot_id WHERE r.id=?",
  )
    .bind(c.req.param("id"))
    .first();
  if (!row) throw new AppError(404, "NOT_FOUND", "Webhook 发送记录不存在。");
  if (row.expires_at <= now())
    throw new AppError(410, "CONTENT_EXPIRED", "Webhook 发送记录已过期。");
  return row;
}

api.get("/webhook/records", async (c) => {
  const where = ["r.expires_at>?"];
  const values: unknown[] = [now()];
  const result = c.req.query("result");
  const kind = c.req.query("kind");
  if (result) {
    if (!webhookRecordResults.has(result))
      throw new AppError(400, "BAD_REQUEST", "Webhook 记录结果筛选无效。");
    where.push("r.result=?");
    values.push(result);
  }
  if (kind) {
    if (!webhookRecordKinds.has(kind))
      throw new AppError(400, "BAD_REQUEST", "Webhook 记录类型筛选无效。");
    where.push("r.kind=?");
    values.push(kind);
  }
  const cursor = c.req.query("cursor");
  if (cursor) {
    const [startedAt, id] = cursorDecode(cursor);
    where.push("(r.started_at<? OR (r.started_at=? AND r.id<?))");
    values.push(startedAt, startedAt, id);
  }
  const limit = pageLimit(c.req.query("limit"));
  values.push(limit + 1);
  const rows = await c.env.DB.prepare(
    `SELECT r.id,r.delivery_id,r.event_id,r.kind,r.attempt_number,r.endpoint_url,r.started_at,r.finished_at,r.result,r.http_status,r.duration_ms,r.error_code,r.response_content_type,r.response_captured_bytes,r.response_truncated,r.response_excerpt,r.expires_at,m.subject_preview,m.envelope_to_normalized FROM webhook_send_records r LEFT JOIN webhook_deliveries d ON d.id=r.delivery_id LEFT JOIN messages m ON m.id=d.message_id WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC,r.id DESC LIMIT ?`,
  )
    .bind(...values)
    .all<any>();
  const hasMore = rows.results.length > limit;
  const visible = rows.results.slice(0, limit);
  const last = visible.at(-1);
  return ok(c, {
    records: visible.map(webhookRecordJson),
    next_cursor:
      hasMore && last ? cursorEncode(last.started_at, last.id) : null,
  });
});

api.get("/webhook/records/:id", async (c) => {
  const row = await webhookRecord(c);
  let requestHeaders: Record<string, string>;
  try {
    requestHeaders = JSON.parse(row.request_headers_json);
  } catch {
    requestHeaders = {};
  }
  const safe = { ...row };
  delete safe.request_headers_json;
  delete safe.payload_object_key;
  delete safe.raw_object_key;
  delete safe.response_object_key;
  return ok(c, webhookRecordJson({ ...safe, request_headers: requestHeaders }));
});

api.get("/webhook/records/:id/payload", async (c) => {
  const row = await webhookRecord(c);
  const object = await c.env.MAIL_STORAGE.get(row.payload_object_key);
  if (!object)
    throw new AppError(404, "NOT_FOUND", "Webhook 请求内容不可用。");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

api.get("/webhook/records/:id/raw", async (c) => {
  const row = await webhookRecord(c);
  const object = await c.env.MAIL_STORAGE.get(row.raw_object_key);
  if (!object)
    throw new AppError(404, "NOT_FOUND", "Webhook 请求内容不可用。");
  return new Response(object.body, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${safeDownloadName(row.raw_filename)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

api.get("/webhook/records/:id/response", async (c) => {
  const row = await webhookRecord(c);
  if (!row.response_object_key)
    return new Response("", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  const object = await c.env.MAIL_STORAGE.get(row.response_object_key);
  if (!object)
    throw new AppError(404, "NOT_FOUND", "Webhook 响应内容不可用。");
  return new Response(object.body, {
    headers: {
      "Content-Type": row.response_content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${row.id}-response.body"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

api.get("/webhook/deliveries", async (c) => {
  const where: string[] = [];
  const values: unknown[] = [];
  if (c.req.query("status")) {
    where.push("d.status=?");
    values.push(c.req.query("status"));
  }
  if (c.req.query("message_id")) {
    where.push("d.message_id=?");
    values.push(c.req.query("message_id"));
  }
  values.push(pageLimit(c.req.query("limit")));
  const rows = await c.env.DB.prepare(
    `SELECT d.*,m.subject_preview,m.envelope_to_normalized FROM webhook_deliveries d JOIN messages m ON m.id=d.message_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.created_at DESC LIMIT ?`,
  )
    .bind(...values)
    .all<any>();
  return ok(
    c,
    rows.results.map((r) => ({
      ...r,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
      delivered_at: iso(r.delivered_at),
      next_attempt_at: iso(r.next_attempt_at),
    })),
  );
});
api.get("/webhook/deliveries/:id", async (c) => {
  const delivery = await required<any>(
    c.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id=?").bind(
      c.req.param("id"),
    ),
    "投递任务不存在。",
  );
  const attempts = await c.env.DB.prepare(
    "SELECT * FROM webhook_attempts WHERE delivery_id=? ORDER BY attempt_number DESC LIMIT 50",
  )
    .bind(delivery.id)
    .all<any>();
  return ok(c, { delivery, attempts: attempts.results });
});
api.post("/webhook/deliveries/:id/retry", async (c) => {
  const timestamp = now();
  const result = await c.env.DB.prepare(
    "UPDATE webhook_deliveries SET status='pending',cycle_attempts=0,cycle_started_at=NULL,retry_deadline_at=NULL,next_attempt_at=?,last_error_code=NULL,updated_at=? WHERE id=? AND status IN ('failed','paused','succeeded') AND EXISTS(SELECT 1 FROM messages m WHERE m.id=message_id AND m.deleted_at IS NULL AND m.raw_state='available' AND m.raw_expires_at>?)",
  )
    .bind(timestamp, timestamp, c.req.param("id"), timestamp)
    .run();
  if (!Number(result.meta.changes))
    throw new AppError(
      410,
      "CONTENT_EXPIRED",
      "任务不可重试或完整内容已过期。",
    );
  c.executionCtx.waitUntil(runMaintenance(c.env, timestamp));
  return ok(c, { status: "pending" }, 202);
});
api.post("/webhook/deliveries/:id/cancel", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE webhook_deliveries SET status='canceled',last_error_code='MANUAL_CANCEL',updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed','expired','canceled')",
  )
    .bind(now(), c.req.param("id"))
    .run();
  if (!Number(result.meta.changes))
    throw new AppError(409, "CONFLICT", "任务已终止或不存在。");
  return ok(c, { status: "canceled" });
});
api.post("/messages/:id/webhook", async (c) => {
  const timestamp = now();
  const message = await required<any>(
    c.env.DB.prepare(
      "SELECT id,event_id,content_object_key,raw_state,raw_expires_at FROM messages WHERE id=? AND deleted_at IS NULL",
    ).bind(c.req.param("id")),
    "邮件不存在。",
  );
  if (message.raw_state !== "available" || message.raw_expires_at <= timestamp)
    throw new AppError(410, "CONTENT_EXPIRED", "完整内容已过期。");
  const settings = await c.env.DB.prepare(
    "SELECT webhook_enabled,webhook_url,webhook_revision FROM app_settings WHERE singleton=1",
  ).first<any>();
  if (!settings?.webhook_enabled || !settings.webhook_url)
    throw new AppError(409, "CONFLICT", "Webhook 尚未启用。");
  const id = uuid();
  try {
    await c.env.DB.prepare(
      "INSERT INTO webhook_deliveries(id,message_id,event_id,endpoint_url_snapshot,endpoint_revision,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        message.id,
        message.event_id,
        settings.webhook_url,
        settings.webhook_revision,
        message.content_object_key ? "pending" : "waiting_content",
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
  } catch {
    const existing = await c.env.DB.prepare(
      "SELECT id,status FROM webhook_deliveries WHERE event_id=? AND endpoint_revision=?",
    )
      .bind(message.event_id, settings.webhook_revision)
      .first();
    return ok(c, existing, 200);
  }
  c.executionCtx.waitUntil(runMaintenance(c.env, timestamp));
  return ok(
    c,
    { id, status: message.content_object_key ? "pending" : "waiting_content" },
    202,
  );
});

api.get("/system/status", async (c) => {
  const counts = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM messages WHERE parse_state='queued' AND deleted_at IS NULL) pending_parse,(SELECT COUNT(*) FROM messages WHERE parse_state='failed' AND deleted_at IS NULL) failed_parse,(SELECT COUNT(*) FROM webhook_deliveries WHERE status IN ('waiting_content','pending','retry_wait','inflight','paused')) pending_webhooks,(SELECT COUNT(*) FROM webhook_deliveries WHERE status='failed') failed_webhooks,(SELECT MIN(next_attempt_at) FROM webhook_deliveries WHERE status IN ('pending','retry_wait')) oldest_backlog,(SELECT COUNT(*) FROM attachments WHERE expires_at<=? AND state!='deleted') pending_delete,(SELECT MAX(received_at) FROM messages WHERE deleted_at IS NULL) last_received_at",
  )
    .bind(now())
    .first<any>();
  const states = await c.env.DB.prepare(
    "SELECT key,value_int FROM maintenance_state",
  ).all<{ key: string; value_int: number }>();
  return ok(c, {
    bindings: {
      db: true,
      r2: true,
      assets: true,
      webhook_secret: Boolean(c.env.WEBHOOK_SIGNING_SECRET),
    },
    ...counts,
    last_received_at: iso(counts?.last_received_at),
    oldest_backlog: iso(counts?.oldest_backlog),
    maintenance: Object.fromEntries(
      states.results.map((s) => [s.key, iso(s.value_int)]),
    ),
  });
});
api.post("/system/maintenance", async (c) =>
  ok(c, await runMaintenance(c.env, now())),
);
