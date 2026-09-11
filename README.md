[English](README.md) · [简体中文](README_CN.md)

# Latchmail

Latchmail is a single-admin, receive-only catch-all inbox for Cloudflare. Every address on an enabled domain can receive mail; address registrations only add an optional label and note, and are not an allow-list. Complete raw EML is written reliably to private R2 first, then parsed, indexed and delivered through recoverable D1 tasks and full-content webhooks.

## Features

- One Module Worker handles HTTP, Email Routing and a per-minute Cron
- D1 manages domains, labels, address registrations, message indexes, leases, the Outbox and maintenance state
- Private R2 storage for raw EML, immutable payload JSON and regular/CID attachments
- Bilingual React/Vite management UI with browser-language detection and persisted language choice; search, filters, read/archive/delete state, message bodies, attachments and delivery diagnostics
- Streaming multipart Webhooks with `payload` JSON plus `raw_email` EML, HMAC-SHA256 signatures, bounded automatic retries and manual redelivery
- Per-message attachment/raw retention snapshots from 1–3650 days, logical expiry before physical cleanup, and idempotent Cron deletion
- Cookie/CSRF/Bearer authentication, persistent login rate limiting, validated Webhook destinations and isolated email HTML

The product does not include sending, replies, forwarding, SMTP/IMAP/POP, multiple users, public temporary mailboxes, AI, OTP extraction or Push.

## Local setup

Requires Node.js 22+.

```bash
npm ci
copy .dev.vars.example .dev.vars
npm run dev
```

Set independent `ADMIN_PASSWORD` and `SESSION_SECRET` values in `.dev.vars`. `ADMIN_API_TOKEN` is optional and enables Bearer API access; `WEBHOOK_SIGNING_SECRET` is required only when Webhooks are enabled and must be standard Base64 for exactly 32 random bytes. The local Worker uses a generated, ignored deployment manifest and initializes its D1 schema automatically. Open `http://127.0.0.1:8787` in a browser. After adding and enabling `example.com`, submit a synthetic message from another terminal:

```bash
npm run email:fixture -- tests/fixtures/attachment.eml sender@example.net asus@example.com
```

For split development, run `npm run dev:web` and `npm run dev:worker`; Vite proxies API requests to the local Worker.

## Verification

```bash
npm run check
npm run test:e2e
node scripts/measure-mail.mjs
```

`check` runs type checking, lint, unit tests, Workers D1/R2 integration tests, the frontend build and a Wrangler dry run. Real MX/Email Routing behavior, SMTP failure semantics and an external HTTPS Webhook still require an authorized staging environment.

## Webhook structure

Each complete-mail Webhook is one `POST multipart/form-data` request with exactly two parts:

- `payload`: `application/json; charset=utf-8`, describing the event, message metadata, parse result and attachment index
- `raw_email`: `message/rfc822`, containing the complete original EML; attachments are already included in the EML and are not duplicated as separate parts

The core `payload` shape is:

```json
{
  "schema_version": "1.0",
  "event": "email.received",
  "event_id": "uuid",
  "occurred_at": "2026-09-11T09:30:00.000Z",
  "data": {
    "message_id": "uuid",
    "domain": "example.com",
    "received_at": "2026-09-11T09:30:00.000Z",
    "envelope": {
      "from": "sender@example.net",
      "to": "team@example.com",
      "to_normalized": "team@example.com"
    },
    "registration": null,
    "parse_status": "ready",
    "parse_error": null,
    "headers": [{ "name": "Subject", "value": "Hello" }],
    "rfc_message_id": "<message@example.net>",
    "from": { "address": "sender@example.net", "name": null },
    "to": [{ "address": "team@example.com", "name": null }],
    "cc": [],
    "reply_to": [],
    "bcc_observed": [],
    "subject": "Hello",
    "text": "Plain text body",
    "html": null,
    "attachments": [],
    "raw_email": {
      "part_name": "raw_email",
      "filename": "message-id.eml",
      "content_type": "message/rfc822",
      "size_bytes": 1234,
      "sha256": "hex-encoded-sha256",
      "expires_at": "2026-10-11T09:30:00.000Z"
    }
  }
}
```

Requests include `X-Inbox-Event-Id`, `X-Inbox-Delivery-Id`, `X-Inbox-Timestamp`, `X-Inbox-Payload-SHA256` and `X-Inbox-Signature: v1,<base64>`. The signature input is `event_id.delivery_id.timestamp.payload_sha256`, authenticated with HMAC-SHA256 using the configured 32-byte key. Receivers should verify the raw payload bytes, signature, timestamp window and SHA-256 before parsing JSON, and deduplicate by `event_id`.

Any 2xx response succeeds. Network errors, timeouts, 408, 425, 429 and 5xx responses are retried; other 4xx responses terminate automatic retries. There are at most eight attempts, for up to 24 hours or until the raw message expires. See the full [Webhook protocol](docs/WEBHOOK.md) and sample receiver for all fields and implementation details.

## Deployment

Latchmail does not commit a Wrangler configuration file and never requires deployment users to edit repository files. Create a D1 database and private R2 bucket with names that suit your account, then configure these Workers Builds variables:

- `LATCHMAIL_D1_DATABASE_NAME`, `LATCHMAIL_D1_DATABASE_ID`, `LATCHMAIL_R2_BUCKET_NAME` and the exact HTTPS `APP_ORIGIN` are required.
- `ENVIRONMENT` is optional and defaults to `production`; Workers Builds supplies the connected Worker name, while external CLI deployment may set `LATCHMAIL_WORKER_NAME`.
- Add `ADMIN_PASSWORD` and `SESSION_SECRET` as encrypted build Secrets. `ADMIN_API_TOKEN` and `WEBHOOK_SIGNING_SECRET` remain optional.

Set the Builds deploy command to `npm run deploy:cloudflare`. It validates the values, builds the WebUI, creates an ignored temporary deployment manifest and Secrets file, uploads the Worker, and removes the temporary files. On first access, the Worker uses its D1 binding to apply any pending numbered migrations transactionally; there is no manual SQL step or database connection string. Resource names such as `latchmail-db` and `latchmail-mail` are suggestions only, never required values.

Use the [Cloudflare dashboard deployment guide](docs/DEPLOYMENT_CLOUDFLARE_DASHBOARD.md) for the complete browser workflow or the [operator deployment guide](docs/DEPLOYMENT.md) for local CLI deployment. Do not overwrite an existing MX provider unintentionally.

More documentation: [architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [WebUI languages](docs/I18N.md) · [brand assets](docs/BRAND_ASSETS.md) · [Webhook](docs/WEBHOOK.md) · [deployment](docs/DEPLOYMENT.md) · [Cloudflare dashboard deployment](docs/DEPLOYMENT_CLOUDFLARE_DASHBOARD.md) · [operations](docs/OPERATIONS.md) · [testing](docs/TESTING.md)

MIT licensed.
