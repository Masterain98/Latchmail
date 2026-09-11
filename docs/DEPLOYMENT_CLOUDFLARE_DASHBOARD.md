[English](DEPLOYMENT_CLOUDFLARE_DASHBOARD.md) · [简体中文](DEPLOYMENT_CLOUDFLARE_DASHBOARD_CN.md)

# Deploy with the Cloudflare dashboard

This guide deploys Latchmail from a Git repository through Cloudflare Workers Builds. No repository file needs to be edited, no SQL needs to be pasted into D1, and no traditional database connection string is used.

## 1. Create storage resources

In **Storage & Databases → D1**, create a database and record both its name and UUID. In **R2 Object Storage**, create a private bucket and record its name. Choose names appropriate for your account; `latchmail-db` and `latchmail-mail` are examples only. The two resources do not need the same name and neither is required to contain `production`.

Do not enable the public `r2.dev` URL. Raw EML, immutable structured payloads and attachments must remain private.

For a separate staging deployment, create a different Worker, D1 database and R2 bucket. Never point staging and production at the same storage resources.

## 2. Connect the repository

1. Open **Workers & Pages**, create or select the Worker that will run Latchmail, and connect the Git repository under **Settings → Builds**.
2. Select the production branch. Disable non-production branch deployments by default so preview code cannot access production mail or Secrets.
3. Leave the build command empty. Set the deploy command to:

   ```text
   npm run deploy:cloudflare
   ```

Cloudflare supplies the connected Worker name through `WRANGLER_CI_OVERRIDE_NAME`. The deployment script creates an ignored temporary manifest, uploads the Worker and removes the manifest afterward. Cloudflare's configless auto-configuration is therefore not used and will not open a configuration pull request.

## 3. Add build variables

Add these under **Settings → Builds → Variables and secrets** as ordinary build variables:

| Name | Required | Value |
| --- | --- | --- |
| `LATCHMAIL_D1_DATABASE_NAME` | Yes | The exact name of the D1 database created above |
| `LATCHMAIL_D1_DATABASE_ID` | Yes | Its UUID from the D1 overview page |
| `LATCHMAIL_R2_BUCKET_NAME` | Yes | The exact name of the private R2 bucket |
| `APP_ORIGIN` | Yes | The exact public HTTPS Origin, with no path or trailing slash |
| `ENVIRONMENT` | No | An operational label; defaults to `production` |
| `LATCHMAIL_WORKER_NAME` | No in Workers Builds | Used only when Cloudflare does not supply `WRANGLER_CI_OVERRIDE_NAME` |

`APP_ORIGIN` must equal the browser Origin, for example `https://mail.example.com` or the assigned `workers.dev` Origin. It cannot contain a path, query, fragment or trailing `/` because authenticated writes compare it exactly.

D1 names and IDs are binding identifiers, not credentials. D1 is accessed through the `DB` binding; there is no host, port, username, password or connection URL to configure.

## 4. Add encrypted build Secrets

Create these values as encrypted build Secrets in the same Builds settings. They are made available only to the trusted build and are synchronized to Worker runtime Secrets during deployment.

| Name | Required | Requirement |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | An independently generated, high-entropy value of 32–4096 characters |
| `SESSION_SECRET` | Yes | A different high-entropy value of 32–4096 characters |
| `ADMIN_API_TOKEN` | No | Independent 32–4096 character Bearer credential; omission disables Bearer access on a new deployment |
| `WEBHOOK_SIGNING_SECRET` | Only when Webhooks are enabled | Standard Base64 encoding of exactly 32 random bytes |

Do not use the administrator password as any other key. Do not expose these values as ordinary variables. Because the deployment script can read build Secrets, connect only a repository and production branch you trust.

The Secrets upload is additive: omitting an optional Secret in a later build does not delete an already deployed Secret. Delete that runtime Secret in **Settings → Variables and Secrets** when intentionally disabling it.

## 5. Deploy and initialize

Trigger the production build. The command validates all instance values and Secret formats before upload, builds the bilingual WebUI, binds the existing D1/R2 resources, adds the private Assets binding and per-minute Cron, then removes its temporary manifest and Secrets file.

The Worker initializes D1 itself through the bound database. On the first `/healthz`, API, email or scheduled event it creates the migration ledger, detects already applied numbered migrations and applies only pending migrations in transactional batches. A new empty database receives `0001_initial.sql` automatically. A complete legacy first-version schema is baselined; a partial or conflicting schema fails closed instead of being overwritten.

Open `/healthz` and require HTTP `200` with:

```json
{ "status": "ok", "database": "ready" }
```

HTTP `503` with `database: "migration_failed"` means initialization failed. Inspect Worker logs before routing mail; do not manually mark a migration as applied.

## 6. Domain and Email Routing

Attach the intended `workers.dev` address or custom domain to the Worker and confirm that its Origin exactly matches `APP_ORIGIN`. Configure Cloudflare Email Routing only after the health check succeeds. Route catch-all mail to this Email Worker and preserve any existing MX service unless replacing it is intentional.

After logging in with `ADMIN_PASSWORD`, add and enable each recipient domain in Latchmail. Unknown addresses on an enabled domain remain receivable; address registrations only add labels and notes.

## 7. Acceptance checklist

- `/healthz` reports `database: ready` and D1 contains a `d1_migrations` row for `0001_initial.sql`.
- Password login, refresh persistence, logout and CSRF-protected writes work.
- `ADMIN_PASSWORD` is rejected as a Bearer token; optional `ADMIN_API_TOKEN` works only when configured.
- The R2 bucket has no public endpoint and private raw/attachment downloads require authentication.
- A controlled test message to an unregistered address on an enabled domain appears in the WebUI.
- Cron maintenance and, when configured, signed Webhook delivery complete successfully.

Cloud account, DNS and real-mail checks remain `MANUAL_PENDING` until performed with authorized resources.
