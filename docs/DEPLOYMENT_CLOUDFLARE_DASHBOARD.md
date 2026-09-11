[English](DEPLOYMENT_CLOUDFLARE_DASHBOARD.md) · [简体中文](DEPLOYMENT_CLOUDFLARE_DASHBOARD_CN.md)

# Deploy Latchmail through the Cloudflare Dashboard

This guide is for deployments performed through the Cloudflare web dashboard and a Git repository, without running Wrangler deployment commands locally. The recommended workflow uses Cloudflare Workers Builds to build from GitHub; database, R2, Secrets, domains, and Email Routing are configured in the dashboard.

Official references: [Workers Dashboard quickstart](https://developers.cloudflare.com/workers/get-started/dashboard/) · [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [D1 getting started](https://developers.cloudflare.com/d1/get-started/) · [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)

## 1. Prepare for deployment

Confirm that the repository contains:

- `wrangler.jsonc`
- `migrations/0001_initial.sql`
- `src/worker/index.ts`
- `src/web/`
- `package.json` and `package-lock.json`

Recommended production resource names:

| Resource | Recommended name | Purpose |
| --- | --- | --- |
| Worker | `latchmail` | Production Worker |
| D1 | `latchmail-production` | Mail indexes, settings, and task state |
| R2 | `latchmail-production` | Raw EML, parsed payloads, and attachments |

Use separate Worker, D1, and R2 resources for staging. Never share staging data with production.

## 2. Create D1 and R2 in the dashboard

### Create D1

1. Open Cloudflare Dashboard → **Storage & Databases → D1**.
2. Select **Create database** and name it `latchmail-production`.
3. Open the database details and copy the Database ID.
4. Put this ID in the production `database_id` field in `wrangler.jsonc`.
5. Commit the change to the Git repository. A D1 database ID is not a Secret and may be committed; Secret values must not be committed.

### Create R2

1. Open **R2 Object Storage**.
2. Select **Create bucket** and name it `latchmail-production`.
3. Choose the appropriate location and default storage class.
4. Keep the R2 bucket private. Do not enable public `r2.dev` access.
5. Put the bucket name in the production `bucket_name` field in `wrangler.jsonc` and commit the change.

The production configuration must keep these binding names:

- D1: `DB`
- R2: `MAIL_STORAGE`
- Static assets: `ASSETS`

If the dashboard asks you to add bindings manually, use these variable names under the Worker **Settings → Bindings** section. A wrong binding name can produce a successful build while preventing the Worker from accessing D1 or object storage at runtime.

## 3. Configure the production origin

Set the real same-origin HTTPS address in the production environment of `wrangler.jsonc`, for example:

```jsonc
"vars": {
  "APP_ORIGIN": "https://inbox.example.com",
  "ENVIRONMENT": "production"
}
```

`APP_ORIGIN` must exactly match the browser Origin. It must not include a path or a trailing `/`; authenticated writes validate this value.

Ordinary variables may remain in `wrangler.jsonc`. Passwords, API tokens, and signing keys must not be written there.

## 4. Add Secrets in the Cloudflare dashboard

1. Open **Workers & Pages**.
2. Select the `latchmail` Worker.
3. Open **Settings → Variables and Secrets**.
4. Select **Add** and choose the **Secret** type.
5. Add these Secrets:

| Name | Required | Rule |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | At least 32 characters, using a high-entropy random value |
| `SESSION_SECRET` | Yes | A high-entropy value independent from the administrator password |
| `ADMIN_API_TOKEN` | No | An independent token when automated Bearer API access is needed |
| `WEBHOOK_SIGNING_SECRET` | When Webhooks are enabled | Standard Base64 encoding of exactly 32 random bytes |

Select **Deploy** after saving so the Secret bindings are included in a Worker version. The values are available at runtime through names such as `env.ADMIN_PASSWORD`, but are hidden from the repository and the dashboard list.

If you use staging, configure a separate set of Secrets on the `latchmail-staging` Worker. Do not reuse session secrets or administrator passwords between staging and production.

## 5. Initialize the D1 database

The dashboard can execute the SQL directly:

1. Open **Storage & Databases → D1 → `latchmail-production`**.
2. Open **Console / SQL**.
3. Open [`migrations/0001_initial.sql`](../migrations/0001_initial.sql) from the repository.
4. Paste the complete SQL into the D1 Console and execute it once.
5. Confirm that the `app_settings` table exists and has exactly one row with `singleton=1`.

Do not execute the same initialization SQL twice. It creates the tables and indexes; D1/R2 data is not part of Worker version rollback. When adding future migrations, use a new number, apply it separately, and record the execution time and target database.

## 6. Deploy from Git with Workers Builds

1. Open **Workers & Pages → Create application**.
2. Select **Import an existing Git repository**, authorize GitHub, and choose the Latchmail repository.
3. Set the production Worker name to `latchmail`.
4. Use these build settings:

   - Build command: `npm ci && npm run build`
   - Deploy command: `npx wrangler deploy --env production`
   - Root directory: repository root
   - Node.js: 22 or newer

5. Confirm that the build uses the repository's `wrangler.jsonc` and that the production D1 ID, R2 bucket name, and `APP_ORIGIN` contain real values.
6. Select **Save and Deploy**.
7. Open **Deployments → Version history** and confirm that the new version is serving 100% of traffic.

Do not print Secrets in build logs, and do not put them in GitHub Actions, ordinary `vars`, or frontend build variables. Cloudflare provides Secrets to the Worker as encrypted environment bindings.

If the team does not use Workers Builds, the Worker can also be deployed through **Edit Code**, but this project includes a Vite build, D1/R2 bindings, and static assets. Git-based builds are recommended for reproducibility.

## 7. Configure the custom domain and Email Routing

### Custom domain

1. Open the `latchmail` Worker → **Settings → Domains & Routes**.
2. Add the production custom domain, for example `inbox.example.com`.
3. Confirm that this domain exactly matches `APP_ORIGIN`.
4. Wait for TLS to become active before testing login.

### Email Routing catch-all

1. Open the domain → **Email Routing**.
2. Confirm that Email Routing is enabled for the domain.
3. Create or edit the catch-all rule.
4. Choose **Send to a Worker** and select `latchmail`.
5. Confirm that existing MX records or higher-priority specific address rules are not unintentionally overridden.
6. Return to the Latchmail WebUI and add and enable the same domain.

## 8. Verify the first deployment

Verify in this order:

1. Open `https://inbox.example.com/healthz`; it should return HTTP 200 and `{"status":"ok"}`.
2. Open the WebUI and enter `ADMIN_PASSWORD`.
3. In the browser Network panel, confirm that `POST /api/auth/login` returns 200 and sets the `__Host-latchmail-session` Cookie.
4. Refresh the page and confirm that the session remains active; after logout, visiting the page again should show the login screen.
5. Add and enable a test domain in the WebUI.
6. Send mail from an external mailbox to a registered address and confirm:
   - Email Routing delivers the message to the Worker;
   - the message appears in the WebUI;
   - D1 contains the message index;
   - R2 contains the raw EML and parsed payload;
   - raw EML and attachment downloads require authentication.
7. Send another message to a random unregistered address under the same enabled domain and confirm that it is still accepted.
8. If Webhooks are configured, confirm receiver signature validation, raw-byte integrity, and `event_id` idempotency.
9. If `ADMIN_API_TOKEN` is configured, call a protected API with it and confirm that `ADMIN_PASSWORD` is rejected as a Bearer credential.

Example:

```bash
curl -i https://inbox.example.com/healthz
curl -i https://inbox.example.com/api/domains \
  -H "Authorization: Bearer <ADMIN_API_TOKEN>"
```

## 9. Rollback and change notes

- Worker code rollback: open **Deployments → Version history**, select a verified previous version, and deploy it again.
- D1 and R2 data do not roll back with a Worker version. Do not roll back to incompatible code after a schema migration has been applied.
- To change the administrator password, update the `ADMIN_PASSWORD` Secret and deploy a new version; existing browser sessions remain controlled by `SESSION_SECRET`.
- To invalidate every browser session immediately, rotate `SESSION_SECRET` and deploy.
- When migrating an existing deployment from `ADMIN_TOKEN`, add the new version's `ADMIN_PASSWORD` and `ADMIN_API_TOKEN`, verify the new version, and only then delete the old Secret.
- During a mail incident, pause Email Routing or the catch-all, preserve D1/R2 data, then roll back code and complete end-to-end verification.

## 10. Dashboard deployment checklist

- [ ] D1 `latchmail-production` is created and the initialization SQL has run
- [ ] A private R2 bucket is created
- [ ] `DB`, `MAIL_STORAGE`, and `ASSETS` binding names are correct
- [ ] Production `APP_ORIGIN` is a real HTTPS Origin
- [ ] `ADMIN_PASSWORD` and `SESSION_SECRET` are configured as encrypted Secrets
- [ ] Optional `ADMIN_API_TOKEN` / `WEBHOOK_SIGNING_SECRET` are configured as needed
- [ ] Workers Builds completed and deployed the latest version
- [ ] The custom-domain TLS status is active
- [ ] Email Routing catch-all points to the correct Worker
- [ ] Login, refresh, logout, and CSRF-protected writes were verified
- [ ] External mail, random-address receipt, D1/R2, and Webhook acceptance were completed
