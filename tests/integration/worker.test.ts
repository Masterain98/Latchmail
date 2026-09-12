import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../../src/worker/index";
import { runMaintenance } from "../../src/worker/maintenance/service";
import {
  beginSendRecord,
  captureRequestSnapshotFromKeys,
  captureResponseBytes,
  finishSendRecord,
  registerRequestSnapshot,
  responseObjectKey,
  snapshotObjectKeys,
} from "../../src/worker/webhooks/records";

const fixture = `From: Service <notify@example.net>\r\nTo: visible@example.net\r\nSubject: Registration received\r\nMessage-ID: <fixture@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body.\r\n`;
async function clear() {
  const tables = [
    "webhook_send_records",
    "webhook_request_snapshots",
    "webhook_attempts",
    "webhook_deliveries",
    "attachments",
    "receive_dedup",
    "messages",
    "address_registry",
    "tags",
    "domains",
    "auth_rate_limits",
    "job_leases",
    "maintenance_state",
  ];
  for (const table of tables)
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare(
    "UPDATE app_settings SET attachment_retention_days=30,webhook_enabled=0,webhook_url=NULL,webhook_revision=1,updated_at=0 WHERE singleton=1",
  ).run();
}
function email(to: string, raw = fixture): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: "bounce@example.net",
    to,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    headers: new Headers(),
    setReject(message: string) {
      throw new Error(`REJECT:${message}`);
    },
    forward() {
      throw new Error("forward is forbidden");
    },
    reply() {
      throw new Error("reply is forbidden");
    },
  } as unknown as ForwardableEmailMessage;
}
beforeEach(clear);

describe("worker vertical path", () => {
  it("protects APIs and accepts only the independent bearer token", async () => {
    const denied = await worker.fetch!(
      new Request("https://inbox.test/api/domains"),
      env,
      createExecutionContext(),
    );
    expect(denied.status).toBe(401);
    const allowed = await worker.fetch!(
      new Request("https://inbox.test/api/domains", {
        headers: {
          Authorization:
            "Bearer independent-api-token-with-at-least-thirty-two-bytes",
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(allowed.status).toBe(200);

    for (const credential of [
      "admin-password-with-at-least-thirty-two-bytes",
      "incorrect-api-token-with-at-least-thirty-two-bytes",
    ]) {
      const rejected = await worker.fetch!(
        new Request("https://inbox.test/api/domains", {
          headers: { Authorization: `Bearer ${credential}` },
        }),
        env,
        createExecutionContext(),
      );
      expect(rejected.status).toBe(401);
    }

    const withoutApiToken = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "ADMIN_API_TOKEN") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    const disabled = await worker.fetch!(
      new Request("https://inbox.test/api/domains", {
        headers: {
          Authorization:
            "Bearer independent-api-token-with-at-least-thirty-two-bytes",
        },
      }),
      withoutApiToken,
      createExecutionContext(),
    );
    expect(disabled.status).toBe(401);
  });

  it("logs in with a password, creates a secure session and enforces csrf", async () => {
    const oldField = await worker.fetch!(
      new Request("https://inbox.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "admin-password-with-at-least-thirty-two-bytes",
        }),
      }),
      env,
      createExecutionContext(),
    );
    expect(oldField.status).toBe(400);

    const incorrect = await worker.fetch!(
      new Request("https://inbox.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: "incorrect-password-with-at-least-thirty-two-bytes",
        }),
      }),
      env,
      createExecutionContext(),
    );
    expect(incorrect.status).toBe(401);

    const login = await worker.fetch!(
      new Request("https://inbox.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: "admin-password-with-at-least-thirty-two-bytes",
        }),
      }),
      env,
      createExecutionContext(),
    );
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-latchmail-session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);
    const loginBody = await login.json<{
      data: { authenticated: boolean; csrf: string };
    }>();
    expect(loginBody.data.authenticated).toBe(true);
    const cookie = setCookie.split(";", 1)[0]!;

    const session = await worker.fetch!(
      new Request("https://inbox.test/api/auth/session", {
        headers: { Cookie: cookie },
      }),
      env,
      createExecutionContext(),
    );
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toEqual({
      data: {
        authenticated: true,
        auth_mode: "cookie",
        csrf: loginBody.data.csrf,
      },
    });

    const missingCsrf = await worker.fetch!(
      new Request("https://inbox.test/api/system/maintenance", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://inbox.test" },
      }),
      env,
      createExecutionContext(),
    );
    expect(missingCsrf.status).toBe(403);

    const wrongOrigin = await worker.fetch!(
      new Request("https://inbox.test/api/system/maintenance", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://attacker.test",
          "X-CSRF-Token": loginBody.data.csrf,
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(wrongOrigin.status).toBe(403);

    const accepted = await worker.fetch!(
      new Request("https://inbox.test/api/system/maintenance", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://inbox.test",
          "X-CSRF-Token": loginBody.data.csrf,
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(accepted.status).toBe(200);
  });

  it("rate limits repeated password failures", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await worker.fetch!(
        new Request("https://inbox.test/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "203.0.113.10",
          },
          body: JSON.stringify({
            password: "incorrect-password-with-at-least-thirty-two-bytes",
          }),
        }),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
    }
    const limited = await worker.fetch!(
      new Request("https://inbox.test/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
        },
        body: JSON.stringify({
          password: "admin-password-with-at-least-thirty-two-bytes",
        }),
      }),
      env,
      createExecutionContext(),
    );
    expect(limited.status).toBe(429);
  });
  it("rejects private webhook destinations before persisting them", async () => {
    const response = await worker.fetch!(
      new Request("https://inbox.test/api/webhook", {
        method: "PUT",
        headers: {
          Authorization:
            "Bearer independent-api-token-with-at-least-thirty-two-bytes",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          url: "https://127.0.0.1/mail",
          confirm_cancel_pending: true,
        }),
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT webhook_url FROM app_settings").first<{
        webhook_url: string | null;
      }>(),
    ).toEqual({ webhook_url: null });
  });
  it("serves webhook send records safely and removes them after 48 hours", async () => {
    const timestamp = Date.now();
    const id = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const payload = new TextEncoder().encode('{"event":"webhook.test"}');
    const raw = new TextEncoder().encode("Subject: test\r\n\r\nbody\r\n");
    const sourcePayloadKey = `test-sources/${id}/payload.json`;
    const sourceRawKey = `test-sources/${id}/raw.eml`;
    await Promise.all([
      env.MAIL_STORAGE.put(sourcePayloadKey, payload),
      env.MAIL_STORAGE.put(sourceRawKey, raw),
    ]);
    await registerRequestSnapshot(
      env,
      {
        id,
        deliveryId: null,
        rawFilename: "test.eml",
        payloadSize: payload.byteLength,
        rawSize: raw.byteLength,
      },
      timestamp,
    );
    await captureRequestSnapshotFromKeys(
      env,
      id,
      sourcePayloadKey,
      sourceRawKey,
      timestamp,
    );
    await beginSendRecord(
      env,
      {
        id,
        snapshotId: id,
        deliveryId: crypto.randomUUID(),
        eventId,
        kind: "test",
        attemptNumber: 1,
        endpointUrl: "https://hooks.example.com/email",
      },
      timestamp,
    );
    const captured = await captureResponseBytes(
      new Response("accepted", {
        status: 202,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    await finishSendRecord(env, {
      id,
      finishedAt: timestamp + 25,
      result: "succeeded",
      httpStatus: 202,
      durationMs: 25,
      errorCode: null,
      requestHeaders: { "X-Inbox-Signature": "v1,[NOT RETAINED]" },
      response: captured,
    });
    const authorization = {
      Authorization:
        "Bearer independent-api-token-with-at-least-thirty-two-bytes",
    };
    const list = await worker.fetch!(
      new Request("https://inbox.test/api/webhook/records", {
        headers: authorization,
      }),
      env,
      createExecutionContext(),
    );
    expect(list.status).toBe(200);
    expect((await list.json<any>()).data.records[0]).toMatchObject({
      id,
      http_status: 202,
      response_captured_bytes: 8,
      response_truncated: false,
    });
    const detail = await worker.fetch!(
      new Request(`https://inbox.test/api/webhook/records/${id}`, {
        headers: authorization,
      }),
      env,
      createExecutionContext(),
    );
    const detailBody = await detail.json<any>();
    expect(detailBody.data.request_headers).toEqual({
      "X-Inbox-Signature": "v1,[NOT RETAINED]",
    });
    expect(JSON.stringify(detailBody)).not.toContain("object_key");
    expect(Date.parse(detailBody.data.expires_at)).toBe(
      timestamp + 25 + 48 * 60 * 60 * 1000,
    );
    for (const [path, expected] of [
      ["payload", '{"event":"webhook.test"}'],
      ["raw", "Subject: test\r\n\r\nbody\r\n"],
      ["response", "accepted"],
    ]) {
      const response = await worker.fetch!(
        new Request(`https://inbox.test/api/webhook/records/${id}/${path}`, {
          headers: authorization,
        }),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
        expected,
      );
    }
    const expiredAt = Date.now() - 1;
    const expired = await worker.fetch!(
      new Request(`https://inbox.test/api/webhook/records/${id}`, {
        headers: authorization,
      }),
      env,
      createExecutionContext(),
    );
    await env.DB.batch([
      env.DB.prepare("UPDATE webhook_send_records SET expires_at=? WHERE id=?").bind(
        expiredAt,
        id,
      ),
      env.DB.prepare(
        "UPDATE webhook_request_snapshots SET expires_at=? WHERE id=?",
      ).bind(expiredAt, id),
    ]);
    const logicallyExpired = await worker.fetch!(
      new Request(`https://inbox.test/api/webhook/records/${id}`, {
        headers: authorization,
      }),
      env,
      createExecutionContext(),
    );
    expect(expired.status).toBe(200);
    expect(logicallyExpired.status).toBe(410);
    const listAfterExpiry = await worker.fetch!(
      new Request("https://inbox.test/api/webhook/records", {
        headers: authorization,
      }),
      env,
      createExecutionContext(),
    );
    expect((await listAfterExpiry.json<any>()).data.records).toEqual([]);
    await runMaintenance(env, Date.now());
    expect(
      await env.DB.prepare("SELECT id FROM webhook_send_records WHERE id=?")
        .bind(id)
        .first(),
    ).toBeNull();
    expect(
      await env.MAIL_STORAGE.head(responseObjectKey(id)),
    ).toBeNull();
    const snapshotKeys = snapshotObjectKeys(id);
    expect(await env.MAIL_STORAGE.head(snapshotKeys.payload)).toBeNull();
    expect(await env.MAIL_STORAGE.head(snapshotKeys.raw)).toBeNull();
    await Promise.all([
      env.MAIL_STORAGE.delete(sourcePayloadKey),
      env.MAIL_STORAGE.delete(sourceRawKey),
    ]);
  });
  it("prunes terminal webhook tasks after 48 hours without removing active tasks", async () => {
    const timestamp = Date.now();
    const old = timestamp - 48 * 60 * 60 * 1000 - 1;
    const domainId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const terminalId = crypto.randomUUID();
    const activeId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO domains(id,domain_ascii,display_name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)",
      ).bind(domainId, "records.example", "records.example", timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO messages(id,event_id,domain_id,received_at,envelope_from,envelope_to_original,envelope_to_normalized,raw_sha256,raw_size_bytes,raw_object_key,raw_expires_at,retention_days_snapshot,notification_requested,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        messageId,
        eventId,
        domainId,
        timestamp,
        "sender@example.net",
        "box@records.example",
        "box@records.example",
        "0".repeat(64),
        0,
        `raw/${messageId}`,
        timestamp + 30 * 86400000,
        30,
        1,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        "INSERT INTO webhook_deliveries(id,message_id,event_id,endpoint_url_snapshot,endpoint_revision,status,created_at,updated_at) VALUES(?,?,?,?,?,'succeeded',?,?)",
      ).bind(
        terminalId,
        messageId,
        eventId,
        "https://hooks.example.com/old",
        1,
        old,
        old,
      ),
      env.DB.prepare(
        "INSERT INTO webhook_deliveries(id,message_id,event_id,endpoint_url_snapshot,endpoint_revision,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?)",
      ).bind(
        activeId,
        messageId,
        eventId,
        "https://hooks.example.com/current",
        2,
        timestamp + 60000,
        old,
        old,
      ),
    ]);
    await env.DB.prepare(
      "INSERT INTO webhook_attempts(id,delivery_id,attempt_number,started_at,finished_at,result) VALUES(?,?,?,?,?,'succeeded')",
    )
      .bind(crypto.randomUUID(), terminalId, 1, old, old)
      .run();
    await runMaintenance(env, timestamp);
    expect(
      await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id=?")
        .bind(terminalId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id=?")
        .bind(activeId)
        .first(),
    ).not.toBeNull();
  });
  it("accepts an unregistered recipient, persists exact raw bytes and parses through maintenance", async () => {
    const now = Date.now();
    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO domains(id,domain_ascii,display_name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)",
    )
      .bind(domainId, "example.com", "example.com", now, now)
      .run();
    const ctx = createExecutionContext();
    await worker.email!(email("random+exact@example.com"), env, ctx);
    await waitOnExecutionContext(ctx);
    const row = await env.DB.prepare("SELECT * FROM messages").first<any>();
    expect(row.envelope_to_normalized).toBe("random+exact@example.com");
    expect(row.parse_state).toBe("ready");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) count FROM address_registry",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
    const raw = await env.MAIL_STORAGE.get(row.raw_object_key);
    expect(await raw?.text()).toBe(fixture);
    const payload = await env.MAIL_STORAGE.get(row.content_object_key);
    expect(((await payload?.json()) as any).data.text).toContain(
      "Synthetic body",
    );
  });
  it("deduplicates exact envelope and bytes but not different recipients", async () => {
    const now = Date.now(),
      domainId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO domains(id,domain_ascii,display_name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)",
    )
      .bind(domainId, "example.com", "example.com", now, now)
      .run();
    for (const to of [
      "same@example.com",
      "same@example.com",
      "other@example.com",
    ]) {
      const ctx = createExecutionContext();
      await worker.email!(email(to), env, ctx);
      await waitOnExecutionContext(ctx);
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) count FROM messages",
    ).first<{ count: number }>();
    expect(count?.count).toBe(2);
  });
  it("dynamically reflects post-receive address registration", async () => {
    const now = Date.now(),
      domainId = crypto.randomUUID(),
      tagId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO domains(id,domain_ascii,display_name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)",
      ).bind(domainId, "example.com", "example.com", now, now),
      env.DB.prepare(
        "INSERT INTO tags(id,name,name_normalized,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).bind(tagId, "ASUS", "asus", now, now),
    ]);
    let ctx = createExecutionContext();
    await worker.email!(email("asus@example.com"), env, ctx);
    await waitOnExecutionContext(ctx);
    await env.DB.prepare(
      "INSERT INTO address_registry(id,domain_id,local_part,address_normalized,tag_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        domainId,
        "asus",
        "asus@example.com",
        tagId,
        now,
        now,
      )
      .run();
    ctx = createExecutionContext();
    const response = await worker.fetch!(
      new Request("https://inbox.test/api/messages", {
        headers: {
          Authorization:
            "Bearer independent-api-token-with-at-least-thirty-two-bytes",
        },
      }),
      env,
      ctx,
    );
    const json = (await response.json()) as any;
    expect(json.data[0].current_registration.tag.name).toBe("ASUS");
    const stored = await env.DB.prepare(
      "SELECT registration_snapshot_json FROM messages",
    ).first<{ registration_snapshot_json: string | null }>();
    expect(stored?.registration_snapshot_json).toBeNull();
  });

  it("stores all decoded attachments then expires raw and attachments without deleting content", async () => {
    const receivedAt = Date.now();
    const domainId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO domains(id,domain_ascii,display_name,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)",
      ).bind(domainId, "example.com", "example.com", receivedAt, receivedAt),
      env.DB.prepare(
        "UPDATE app_settings SET attachment_retention_days=1 WHERE singleton=1",
      ),
    ]);
    const raw =
      'From: Fixture <fixture@example.net>\r\nTo: asus@example.com\r\nSubject: Attachment\r\nMessage-ID: <attachment@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="edge"\r\n\r\n--edge\r\nContent-Type: text/plain\r\n\r\nBody\r\n--edge\r\nContent-Type: text/plain; name="same.txt"\r\nContent-Disposition: attachment; filename="same.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nU3ludGhldGljIG9uZQ==\r\n--edge\r\nContent-Type: text/plain; name="same.txt"\r\nContent-Disposition: attachment; filename="same.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nU3ludGhldGljIHR3bw==\r\n--edge--\r\n';
    const ctx = createExecutionContext();
    await worker.email!(email("asus@example.com", raw), env, ctx);
    await waitOnExecutionContext(ctx);
    const message = await env.DB.prepare(
      "SELECT id,content_object_key,raw_expires_at FROM messages",
    ).first<any>();
    const attachments = await env.DB.prepare(
      "SELECT id,object_key,sha256 FROM attachments ORDER BY part_index",
    ).all<any>();
    expect(attachments.results).toHaveLength(2);
    expect(
      new Set(attachments.results.map((item) => item.object_key)).size,
    ).toBe(2);
    expect(new Set(attachments.results.map((item) => item.sha256)).size).toBe(
      2,
    );
    await runMaintenance(env, message.raw_expires_at + 3_600_001);
    const states = await env.DB.prepare(
      "SELECT state FROM attachments ORDER BY part_index",
    ).all<{ state: string }>();
    expect(states.results.map((item) => item.state)).toEqual([
      "deleted",
      "deleted",
    ]);
    expect(
      await env.DB.prepare("SELECT raw_state FROM messages WHERE id=?")
        .bind(message.id)
        .first<{ raw_state: string }>(),
    ).toEqual({ raw_state: "deleted" });
    expect(
      await env.MAIL_STORAGE.get(message.content_object_key),
    ).not.toBeNull();
  });

  it("reclaims only old unreferenced R2 objects with a bounded scan", async () => {
    const timestamp = Date.now();
    await env.MAIL_STORAGE.put("raw/orphan.eml", "synthetic orphan", {
      customMetadata: { createdAt: String(timestamp - 2 * 86400000) },
    });
    await env.MAIL_STORAGE.put("raw/young.eml", "young candidate", {
      customMetadata: { createdAt: String(timestamp) },
    });
    const result = await runMaintenance(env, timestamp);
    expect(result.orphans).toBe(1);
    expect(await env.MAIL_STORAGE.get("raw/orphan.eml")).toBeNull();
    expect(await env.MAIL_STORAGE.get("raw/young.eml")).not.toBeNull();
  });
});
