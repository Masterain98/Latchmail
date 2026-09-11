[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT_CN.md)

# Operator deployment

The preferred production shape is one Worker, one D1 database, one private R2 bucket and the generated per-minute Cron. Resource names are user-selected; suggestions such as `latchmail-db` and `latchmail-mail` are not requirements.

## Prerequisites

Create D1 and R2 before deployment and keep R2 private. Record the D1 name and UUID and the R2 bucket name. Configure the following process environment for `npm run deploy:cloudflare`:

| Variable | Required | Meaning |
| --- | --- | --- |
| `LATCHMAIL_WORKER_NAME` | Outside Workers Builds | Existing or intended Worker name |
| `LATCHMAIL_D1_DATABASE_NAME` | Yes | Existing D1 database name |
| `LATCHMAIL_D1_DATABASE_ID` | Yes | Existing D1 UUID |
| `LATCHMAIL_R2_BUCKET_NAME` | Yes | Existing private R2 bucket name |
| `APP_ORIGIN` | Yes | Exact HTTPS WebUI Origin without a trailing slash |
| `ENVIRONMENT` | No | Operational label; default `production` |

Set `ADMIN_PASSWORD` and `SESSION_SECRET` as independent 32–4096 character values. `ADMIN_API_TOKEN` is optional. `WEBHOOK_SIGNING_SECRET` is required only when Webhooks are enabled and must be standard Base64 for exactly 32 random bytes. The deploy command validates values without printing them and uploads them through an ignored temporary Secrets file.

When running outside Workers Builds, authenticate Wrangler interactively or provide the standard `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` variables. These are Cloudflare CLI credentials, not Latchmail runtime bindings. Grant only the permissions necessary to deploy the Worker and bind the existing resources; runtime D1 initialization does not require the token to execute migrations.

## Deploy

Run:

```bash
npm ci
npm run check
npm run deploy:cloudflare
```

The command builds the WebUI, generates a temporary deployment manifest under the ignored `.wrangler/` directory, uploads the Worker and runtime Secrets, then removes both temporary files. There is no committed Wrangler configuration to customize.

Request `/healthz` after deployment. The Worker uses its `DB` binding to create or upgrade the schema transactionally and returns `database: ready` only after all bundled numbered migrations are present. Never rewrite an applied migration; add the next numbered SQL file and register it in the Worker migration list. The test suite rejects an unregistered migration.

Staging requires separate Worker, D1 and R2 resources and a separate set of environment values. Do not share production mail data with previews. Keep `SESSION_SECRET` stable to preserve browser sessions; rotating it invalidates every session. Updating `ADMIN_PASSWORD` changes future logins, while `ADMIN_API_TOKEN` can be rotated independently.

## Rollout and rollback

Migrations must remain compatible with the previous Worker version during rollout. The runtime migration engine applies each numbered file and its ledger record in one D1 transaction. A failed migration is rolled back and retried on a later invocation; partial or conflicting first-version schemas fail closed.

After `/healthz` succeeds, verify password login, Cookie/CSRF writes, optional Bearer access, private downloads, Cron and a controlled Webhook. Only then attach Email Routing. Preserve existing MX records unless replacement is intentional.

Cloud account, DNS and real-email validation are `MANUAL_PENDING` when authorized credentials are unavailable.
