import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { databaseMigrations } from "../../src/worker/database/migrations";
import { splitSqlStatements } from "../../src/worker/database/initialize";

describe("database migration registry", () => {
  it("registers every numbered SQL migration exactly once", async () => {
    const files = (await readdir("migrations"))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    expect(databaseMigrations.map(({ name }) => name)).toEqual(files);
  });

  it("splits statements without breaking quoted semicolons or comments", () => {
    expect(
      splitSqlStatements(
        "-- first; comment\nCREATE TABLE sample(value TEXT DEFAULT ';'); /* ; */ INSERT INTO sample VALUES('a;''b');",
      ),
    ).toHaveLength(2);
  });
});
