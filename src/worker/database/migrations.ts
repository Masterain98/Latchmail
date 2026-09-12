import initialSql from "../../../migrations/0001_initial.sql";
import webhookSendRecordsSql from "../../../migrations/0002_webhook_send_records.sql";

export interface DatabaseMigration {
  name: string;
  sql: string;
}

export const databaseMigrations: readonly DatabaseMigration[] = Object.freeze([
  { name: "0001_initial.sql", sql: initialSql },
  { name: "0002_webhook_send_records.sql", sql: webhookSendRecordsSql },
]);
