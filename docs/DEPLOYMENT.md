# Deployment

Recommended production plan: Workers Paid, one Worker, one D1 database, one private R2 bucket and one `* * * * *` Cron. Create separate staging and production resources, replace only the placeholder IDs/origins in `wrangler.jsonc`, and never share their data.

1. Install Node 22+, run `npm ci`, `npm run check`, create D1/R2 resources, and apply the target migration command.
2. Set independent `ADMIN_TOKEN` and `SESSION_SECRET` values with at least 32 random bytes. Set `WEBHOOK_SIGNING_SECRET` to standard Base64 of exactly 32 random bytes. Use `wrangler secret put` for each; never place values in `vars`.
3. Set the real same-origin HTTPS `APP_ORIGIN`, deploy staging, verify login and private downloads, then deploy production manually from an approved operator environment.
4. For each domain, enable Cloudflare Email Routing without overwriting an existing mail provider unintentionally. Configure the domain or explicit subdomain MX/routing, set Catch-all to Send to Worker, then add and enable the exact domain in this app. Existing specific rules may take precedence.
5. Send from an independent external mailbox to one registered and one random unregistered address. Verify Worker → WebUI → HTTPS webhook and a forced retry before calling cloud acceptance complete.

Local `.eml` submission: run Wrangler, migrate local D1, add an enabled domain, then `npm run email:fixture -- tests/fixtures/attachment.eml sender@example.net asus@example.com`. Registration UI supports common ASCII local-parts; delivered international local-parts are not rejected by the registration validator and are stored using the explicit lowercase application policy.
