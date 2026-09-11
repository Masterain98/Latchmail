import {
  databaseMigrations,
  type DatabaseMigration,
} from "./migrations";

const MIGRATIONS_TABLE = "d1_migrations";
const initializationPromises = new WeakMap<D1Database, Promise<void>>();

interface SchemaObject {
  type: "table" | "index";
  name: string;
  sql: string | null;
}

interface ExpectedSchemaObject {
  type: "table" | "index";
  name: string;
  normalizedSql: string;
}

interface DatabaseState {
  applied: Set<string>;
  schema: Map<string, string>;
}

export class DatabaseInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseInitializationError";
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!;
    const next = sql[index + 1];
    current += character;

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        current += next;
        index++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (quote === "]") {
        if (character === "]") quote = null;
        continue;
      }
      if (character === quote) {
        if (next === quote) {
          current += next;
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      current += next;
      index++;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      current += next;
      index++;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === ";") {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }

  if (quote || blockComment)
    throw new DatabaseInitializationError(
      "Migration SQL contains an unterminated quote or block comment.",
    );
  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function assertMigrationRegistry(migrations: readonly DatabaseMigration[]) {
  const names = migrations.map((migration) => migration.name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length)
    throw new DatabaseInitializationError(
      "The database migration registry contains duplicate names.",
    );
  const sorted = [...names].sort((left, right) => left.localeCompare(right));
  if (names.some((name, index) => name !== sorted[index]))
    throw new DatabaseInitializationError(
      "Database migrations are not ordered by filename.",
    );
  if (
    migrations.length === 0 ||
    migrations.some(
      ({ name, sql }) =>
        !/^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/i.test(name) ||
        splitSqlStatements(sql).length === 0,
    )
  )
    throw new DatabaseInitializationError(
      "The database migration registry contains an invalid migration.",
    );
}

function normalizeSchemaSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function createdSchemaObjects(sql: string): ExpectedSchemaObject[] {
  return splitSqlStatements(sql).flatMap((statement) => {
    const match = statement.match(
      /^\s*CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/i,
    );
    if (!match) return [];
    const name = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (!name) return [];
    return [
      {
        type: match[1]!.toUpperCase().includes("INDEX") ? "index" : "table",
        name,
        normalizedSql: normalizeSchemaSql(statement),
      } satisfies ExpectedSchemaObject,
    ];
  });
}

async function listSchemaObjects(db: D1Database): Promise<Map<string, string>> {
  const result = await db
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name <> ?",
    )
    .bind(MIGRATIONS_TABLE)
    .all<SchemaObject>();
  return new Map(
    result.results.map(({ type, name, sql }) => [
      `${type}:${name}`,
      normalizeSchemaSql(sql ?? ""),
    ]),
  );
}

async function migrationWasApplied(db: D1Database, name: string) {
  return Boolean(
    await db
      .prepare(`SELECT 1 AS applied FROM ${MIGRATIONS_TABLE} WHERE name=?`)
      .bind(name)
      .first<{ applied: number }>(),
  );
}

async function loadDatabaseState(
  db: D1Database,
): Promise<DatabaseState | null> {
  try {
    const result = await db
      .prepare(
        `SELECT 'migration' AS category,name FROM ${MIGRATIONS_TABLE}
         UNION ALL
         SELECT 'schema' AS category,type || ':' || name || char(0) || coalesce(sql,'') AS name
         FROM sqlite_schema
         WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name <> ?`,
      )
      .bind(MIGRATIONS_TABLE)
      .all<{ category: "migration" | "schema"; name: string }>();
    return {
      applied: new Set(
        result.results
          .filter(({ category }) => category === "migration")
          .map(({ name }) => name),
      ),
      schema: new Map(
        result.results
          .filter(({ category }) => category === "schema")
          .map(({ name }) => {
            const separator = name.indexOf("\u0000");
            return [
              name.slice(0, separator),
              normalizeSchemaSql(name.slice(separator + 1)),
            ];
          }),
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table(?::|\s).*d1_migrations/i.test(message)) return null;
    throw error;
  }
}

async function establishInitialBaseline(
  db: D1Database,
  initialMigration: DatabaseMigration,
  actual: Map<string, string>,
): Promise<boolean> {
  const expected = createdSchemaObjects(initialMigration.sql);
  if (expected.length === 0)
    throw new DatabaseInitializationError(
      "The initial migration does not declare any schema objects.",
    );

  const present = expected.filter(({ type, name }) =>
    actual.has(`${type}:${name}`),
  );
  if (present.length === 0) return false;
  if (present.length !== expected.length) {
    const missing = expected
      .filter(({ type, name }) => !actual.has(`${type}:${name}`))
      .map(({ name }) => name)
      .join(", ");
    throw new DatabaseInitializationError(
      `The D1 database contains a partial Latchmail schema; missing objects: ${missing}.`,
    );
  }
  const conflicts = expected
    .filter(
      ({ type, name, normalizedSql }) =>
        actual.get(`${type}:${name}`) !== normalizedSql,
    )
    .map(({ name }) => name);
  if (conflicts.length)
    throw new DatabaseInitializationError(
      `The D1 database contains conflicting Latchmail schema objects: ${conflicts.join(", ")}.`,
    );

  await db
    .prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE}(name) VALUES(?)`)
    .bind(initialMigration.name)
    .run();
  return true;
}

function verifyInitialSchema(
  actual: Map<string, string>,
  initialMigration: DatabaseMigration,
) {
  const expected = createdSchemaObjects(initialMigration.sql);
  const missing = expected
    .filter(({ type, name }) => !actual.has(`${type}:${name}`))
    .map(({ name }) => name);
  if (missing.length)
    throw new DatabaseInitializationError(
      `The D1 migration ledger exists but required schema objects are missing: ${missing.join(", ")}.`,
    );
  const conflicts = expected
    .filter(
      ({ type, name, normalizedSql }) =>
        actual.get(`${type}:${name}`) !== normalizedSql,
    )
    .map(({ name }) => name);
  if (conflicts.length)
    throw new DatabaseInitializationError(
      `The D1 migration ledger exists but required schema objects conflict: ${conflicts.join(", ")}.`,
    );
}

async function applyMigration(db: D1Database, migration: DatabaseMigration) {
  const statements = splitSqlStatements(migration.sql).filter(
    (statement) => !/^\s*PRAGMA\s+foreign_keys\s*=\s*ON\s*$/i.test(statement),
  );
  const batch = statements.map((statement) => db.prepare(statement));
  batch.push(
    db
      .prepare(`INSERT INTO ${MIGRATIONS_TABLE}(name) VALUES(?)`)
      .bind(migration.name),
  );

  try {
    await db.batch(batch);
  } catch (error) {
    if (await migrationWasApplied(db, migration.name)) return;
    throw new DatabaseInitializationError(
      `Failed to apply database migration ${migration.name}.`,
      { cause: error },
    );
  }
}

export async function initializeDatabase(
  db: D1Database,
  migrations: readonly DatabaseMigration[] = databaseMigrations,
) {
  assertMigrationRegistry(migrations);
  const initialMigration = migrations[0]!;
  let state = await loadDatabaseState(db);
  let changed = false;
  if (!state) {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`,
      )
      .run();
    state = { applied: new Set(), schema: await listSchemaObjects(db) };
  }

  if (!state.applied.has(initialMigration.name)) {
    const baselined = await establishInitialBaseline(
      db,
      initialMigration,
      state.schema,
    );
    if (baselined) {
      state.applied.add(initialMigration.name);
      changed = true;
    }
  }

  for (const migration of migrations) {
    if (!state.applied.has(migration.name)) {
      await applyMigration(db, migration);
      state.applied.add(migration.name);
      changed = true;
    }
  }
  if (changed) state.schema = await listSchemaObjects(db);
  verifyInitialSchema(state.schema, initialMigration);
}

export function ensureDatabase(db: D1Database): Promise<void> {
  const existing = initializationPromises.get(db);
  if (existing) return existing;
  const pending = initializeDatabase(db).catch((error) => {
    initializationPromises.delete(db);
    throw error;
  });
  initializationPromises.set(db, pending);
  return pending;
}

export function clearDatabaseInitializationCache(db: D1Database) {
  initializationPromises.delete(db);
}
