[English](ARCHITECTURE.md) · [简体中文](ARCHITECTURE_CN.md)

# Architecture

One Module Worker exports `fetch`, `email` and `scheduled`. The React/Vite SPA is deployed as Workers Static Assets; `/api/*`, `/healthz` and the local email simulation path run Worker-first. D1 owns bounded indexes, current relationships, leases and task state. The private R2 bucket owns `raw/`, immutable `content/` payloads and decoded `attachments/`.

Receive order is: validate enabled envelope domain → snapshot current registration/settings → stream exact raw bytes to R2 while hashing → D1 batch publishes message, seven-day dedupe key and optional waiting Outbox → `waitUntil` accelerates the same maintenance functions used by Cron. R2 and D1 are not presented as a distributed transaction; ambiguous writes are checked before candidate cleanup.

Parsing is globally leased at one message, uses a run ID, writes every attachment and the immutable JSON payload, then publishes that run by conditional D1 update. After three failed starts a degraded payload still references the intact raw EML. Webhook tasks lease independently, send at most two concurrently, and are recoverable after termination.

Retention is a per-message snapshot. At `expires_at`, raw and attachment reads return 410 even before physical cleanup. Hourly bounded cleanup deletes attachment objects and raw EML; permanent message deletion cancels deliveries immediately and schedules all referenced objects for idempotent purge. `content/` remains until the message itself is deleted.
