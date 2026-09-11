[English](OPERATIONS.md) · [简体中文](OPERATIONS_CN.md)

# Operations

For missing mail check in order: Cloudflare DNS/MX → Email Routing and rule priority → application domain enabled → D1/raw persistence → parse state → active UI filters. For missing notifications check enabled/revision → message-time task creation → payload readiness → paused/expired state → latest HTTP error → receiver signature and idempotency logs. For unreclaimed R2 check logical expiry → last Cron → delete error/retry → raw cleanup → unpublished runs and backups.

The status page shows last observed receipt, parse and delivery backlogs, failed counts, oldest due work, last scheduler/cleanup and pending deletion counts. These are application estimates, not billing data or continuous DNS health.

D1 backup does not contain R2 mail bodies. A recoverable backup must snapshot/export both, preserve object keys and verify references after restore. Do not automatically resend historical webhooks after restore. Service retention cannot delete copies already delivered downstream or placed in independent backups.

One maintenance click runs the same bounded functions as Cron. It cannot accept SQL, URL or object keys. Rotate `ADMIN_PASSWORD` to change browser login, `ADMIN_API_TOKEN` independently for automation, and `SESSION_SECRET` to invalidate all browser sessions; webhook key rotation needs a receiver overlap period. Never enable public `r2.dev` access.

`/healthz` verifies runtime database initialization and returns `503` with `database: migration_failed` if an empty, pending or legacy database cannot be brought to the bundled migration level. Inspect Worker logs and the `d1_migrations` ledger; never edit an applied migration or manually mark a failed migration complete. Build Secrets are uploaded additively, so deleting an optional runtime Secret is an explicit dashboard operation.
