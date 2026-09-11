[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT_CN.md)

# Deployment

For a browser-only Cloudflare workflow, see [Dashboard deployment](DEPLOYMENT_CLOUDFLARE_DASHBOARD.md). The steps below use Wrangler from an approved operator environment.

Recommended production plan: Workers Paid, one Worker, one D1 database, one private R2 bucket and one `* * * * *` Cron. Create separate staging and production resources, replace only the placeholder IDs/origins in `wrangler.jsonc`, and never share their data.

1. Install Node 22+, run `npm ci`, `npm run check`, create D1/R2 resources, and apply the target migration command.
2. In Cloudflare Dashboard, open the target Worker's **Settings → Variables and Secrets**. Add `ADMIN_PASSWORD` and `SESSION_SECRET` as encrypted Secrets with independent values of at least 32 high-entropy characters. Optionally add an independent `ADMIN_API_TOKEN` to enable Bearer API access. Add `WEBHOOK_SIGNING_SECRET` only when Webhooks are enabled; it must be standard Base64 of exactly 32 random bytes. Never save these values as plaintext variables or in `wrangler.jsonc`.
3. As a CLI alternative, run `wrangler secret put ADMIN_PASSWORD --env <environment>`, `wrangler secret put SESSION_SECRET --env <environment>`, and the corresponding commands for optional `ADMIN_API_TOKEN` and `WEBHOOK_SIGNING_SECRET`.
4. Set the real same-origin HTTPS `APP_ORIGIN`, deploy staging, verify password login, cookie/CSRF writes, optional Bearer access and private downloads, then deploy production manually from an approved operator environment.
5. For each domain, enable Cloudflare Email Routing without overwriting an existing mail provider unintentionally. Configure the domain or explicit subdomain MX/routing, set Catch-all to Send to Worker, then add and enable the exact domain in this app. Existing specific rules may take precedence.
6. Send from an independent external mailbox to one registered and one random unregistered address. Verify Worker → WebUI → HTTPS webhook and a forced retry before calling cloud acceptance complete.

For an existing deployment, add `ADMIN_PASSWORD` and optional `ADMIN_API_TOKEN` before deploying this version. Keep the old `ADMIN_TOKEN` during the rollback window, update API clients at cutover, and delete the old Secret only after acceptance. Keeping `SESSION_SECRET` unchanged preserves current browser sessions; rotating it invalidates every session.

Attachment retention and the Webhook URL/enabled state remain runtime application settings in D1. Change them in WebUI without redeploying the Worker.

Local `.eml` submission: run Wrangler, migrate local D1, add an enabled domain, then `npm run email:fixture -- tests/fixtures/attachment.eml sender@example.net asus@example.com`. Registration UI supports common ASCII local-parts; delivered international local-parts are not rejected by the registration validator and are stored using the explicit lowercase application policy.
