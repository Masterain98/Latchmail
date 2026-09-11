import initialSql from "../../../migrations/0001_initial.sql";

export interface DatabaseMigration {
  name: string;
  sql: string;
}

export const databaseMigrations: readonly DatabaseMigration[] = Object.freeze([
  { name: "0001_initial.sql", sql: initialSql },
]);
