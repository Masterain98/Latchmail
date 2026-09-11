[English](API.md) · [简体中文](API_CN.md)

# Management API

All business routes use `/api`, JSON success `{ "data": ... }`, and structured errors `{ "error": { "code", "message", "request_id" } }`. Browser calls use `POST /api/auth/login` with `{ "password": "<ADMIN_PASSWORD>" }`, followed by a signed `__Host-` HttpOnly cookie plus Origin and `X-CSRF-Token` on writes. Automation may use `Authorization: Bearer <ADMIN_API_TOKEN>` when that independent optional Secret is configured. The administrator password is never accepted as a Bearer credential.

Implemented groups: `auth/login|logout|session`; CRUD for `domains`, `tags`, and `addresses`; cursor-list/detail/PATCH/DELETE plus raw download for `messages`; attachment download; retention `settings`; webhook get/put/test, delivery list/detail/retry/cancel and per-message enqueue; system status and bounded maintenance. `GET` never marks a message read.

List filters: `cursor`, `limit`, `domain_id`, `tag_id`, `recipient`, `registered`, `untagged`, `unread`, `archived`, `webhook_status`, `q`. Default limit is 50 and maximum is 100. Search is a bounded parameterized `instr()` query over D1 metadata and current registration information; it never downloads R2 bodies.

Expected status codes are 400 validation, 401 authentication, 403 CSRF/origin, 404 missing, 409 conflict, 410 expired content and 429 login rate limit. Sensitive responses are `Cache-Control: private, no-store`.

`GET /healthz` is unauthenticated and initializes or upgrades the bound D1 database before responding. It returns `200 { "status": "ok", "database": "ready" }` when the schema is ready, or `503 { "status": "unavailable", "database": "migration_failed" }` when initialization cannot complete.
