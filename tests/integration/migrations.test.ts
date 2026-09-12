import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../../src/worker/index";
import {
  clearDatabaseInitializationCache,
  initializeDatabase,
  splitSqlStatements,
} from "../../src/worker/database/initialize";
import { databaseMigrations } from "../../src/worker/database/migrations";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";

interface MigrationTestEnv {
  MIGRATION_DB: D1Database;
  BASELINE_DB: D1Database;
  PARTIAL_DB: D1Database;
  RETRY_DB: D1Database;
  FETCH_DB: D1Database;
  EMAIL_DB: D1Database;
  SCHEDULED_DB: D1Database;
  CORRUPT_DB: D1Database;
  CONFLICT_DB: D1Database;
}

const migrationEnv = env as unknown as typeof env & MigrationTestEnv;

describe("runtime D1 initialization", () => {
  it("initializes an empty database transactionally under concurrent callers", async () => {
    await Promise.all([
      initializeDatabase(migrationEnv.MIGRATION_DB),
      initializeDatabase(migrationEnv.MIGRATION_DB),
    ]);
    expect(
      await migrationEnv.MIGRATION_DB.prepare(
        "SELECT name FROM d1_migrations ORDER BY id",
      ).all<{ name: string }>(),
    ).toMatchObject({
      results: [
        { name: "0001_initial.sql" },
        { name: "0002_webhook_send_records.sql" },
      ],
    });
    expect(
      await migrationEnv.MIGRATION_DB.prepare(
        "SELECT attachment_retention_days FROM app_settings WHERE singleton=1",
      ).first(),
    ).toEqual({ attachment_retention_days: 30 });
  });

  it("recognizes a complete legacy schema without a migration ledger", async () => {
    const statements = splitSqlStatements(databaseMigrations[0]!.sql).filter(
      (statement) => !/^\s*PRAGMA/i.test(statement),
    );
    await migrationEnv.BASELINE_DB.batch(
      statements.map((statement) =>
        migrationEnv.BASELINE_DB.prepare(statement),
      ),
    );
    await initializeDatabase(migrationEnv.BASELINE_DB);
    expect(
      await migrationEnv.BASELINE_DB.prepare(
        "SELECT name FROM d1_migrations",
      ).first(),
    ).toEqual({ name: "0001_initial.sql" });
  });

  it("refuses to baseline an existing schema with conflicting definitions", async () => {
    const conflictingSql = databaseMigrations[0]!.sql.replace(
      "display_name TEXT NOT NULL",
      "display_name INTEGER NOT NULL",
    );
    const statements = splitSqlStatements(conflictingSql).filter(
      (statement) => !/^\s*PRAGMA/i.test(statement),
    );
    await migrationEnv.CONFLICT_DB.batch(
      statements.map((statement) =>
        migrationEnv.CONFLICT_DB.prepare(statement),
      ),
    );
    await expect(initializeDatabase(migrationEnv.CONFLICT_DB)).rejects.toThrow(
      /conflicting Latchmail schema objects: domains/i,
    );
    expect(
      await migrationEnv.CONFLICT_DB.prepare(
        "SELECT name FROM d1_migrations WHERE name='0001_initial.sql'",
      ).first(),
    ).toBeNull();
  });

  it("fails closed for a partial schema and exposes an unavailable health check", async () => {
    await migrationEnv.PARTIAL_DB.prepare(
      "CREATE TABLE domains(id TEXT PRIMARY KEY)",
    ).run();
    const partialEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "DB") return migrationEnv.PARTIAL_DB;
        return Reflect.get(target, property, receiver);
      },
    });
    clearDatabaseInitializationCache(migrationEnv.PARTIAL_DB);
    const response = await worker.fetch!(
      new Request("https://inbox.test/healthz"),
      partialEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      database: "migration_failed",
    });
  });

  it("rolls back a failed migration and succeeds on a corrected retry", async () => {
    const broken = [
      databaseMigrations[0]!,
      {
        name: "0002_retry.sql",
        sql: "CREATE TABLE retry_marker(id INTEGER PRIMARY KEY); INSERT INTO missing_table(id) VALUES(1);",
      },
    ];
    await expect(initializeDatabase(migrationEnv.RETRY_DB, broken)).rejects.toThrow(
      /0002_retry\.sql/,
    );
    expect(
      await migrationEnv.RETRY_DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='retry_marker'",
      ).first(),
    ).toBeNull();
    expect(
      await migrationEnv.RETRY_DB.prepare(
        "SELECT name FROM d1_migrations WHERE name='0002_retry.sql'",
      ).first(),
    ).toBeNull();

    await initializeDatabase(migrationEnv.RETRY_DB, [
      databaseMigrations[0]!,
      {
        name: "0002_retry.sql",
        sql: "CREATE TABLE retry_marker(id INTEGER PRIMARY KEY)",
      },
    ]);
    expect(
      await migrationEnv.RETRY_DB.prepare(
        "SELECT name FROM d1_migrations WHERE name='0002_retry.sql'",
      ).first(),
    ).toEqual({ name: "0002_retry.sql" });
  });

  it("detects a missing required object even when the ledger is current", async () => {
    await initializeDatabase(migrationEnv.CORRUPT_DB);
    await migrationEnv.CORRUPT_DB.prepare("DROP INDEX idx_addresses_tag").run();
    clearDatabaseInitializationCache(migrationEnv.CORRUPT_DB);
    await expect(initializeDatabase(migrationEnv.CORRUPT_DB)).rejects.toThrow(
      /required schema objects are missing/i,
    );
  });

  it("guards fetch, email and scheduled entrypoints with initialization", async () => {
    const withDatabase = (database: D1Database) =>
      new Proxy(env, {
        get(target, property, receiver) {
          if (property === "DB") return database;
          return Reflect.get(target, property, receiver);
        },
      });

    const fetchResponse = await worker.fetch!(
      new Request("https://inbox.test/api/domains", {
        headers: {
          Authorization:
            "Bearer independent-api-token-with-at-least-thirty-two-bytes",
        },
      }),
      withDatabase(migrationEnv.FETCH_DB),
      createExecutionContext(),
    );
    expect(fetchResponse.status).toBe(200);

    let rejection = "";
    const raw = new TextEncoder().encode("Subject: initialization\r\n\r\nbody");
    await worker.email!(
      {
        from: "sender@example.net",
        to: "unknown@example.com",
        raw: new ReadableStream({
          start(controller) {
            controller.enqueue(raw);
            controller.close();
          },
        }),
        rawSize: raw.byteLength,
        headers: new Headers(),
        setReject(message: string) {
          rejection = message;
        },
      } as unknown as ForwardableEmailMessage,
      withDatabase(migrationEnv.EMAIL_DB),
      createExecutionContext(),
    );
    expect(rejection).toContain("not enabled");

    const scheduledContext = createExecutionContext();
    worker.scheduled!(
      {} as ScheduledController,
      withDatabase(migrationEnv.SCHEDULED_DB),
      scheduledContext,
    );
    await waitOnExecutionContext(scheduledContext);

    for (const database of [
      migrationEnv.FETCH_DB,
      migrationEnv.EMAIL_DB,
      migrationEnv.SCHEDULED_DB,
    ]) {
      expect(
        await database
          .prepare(
            "SELECT name FROM d1_migrations WHERE name='0001_initial.sql'",
          )
          .first(),
      ).toEqual({ name: "0001_initial.sql" });
    }
  });
});
