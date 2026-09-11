[English](TESTING.md) · [简体中文](TESTING_CN.md)

# Testing

Commands are defined in `package.json`: `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `build`, `deploy:cloudflare`, and aggregate `check`. Unit tests cover deployment-value validation, temporary Secret cleanup, migration registration and SQL splitting in addition to normalization, contracts and sessions. Workers-runtime integration tests use Miniflare D1/R2 to cover empty-database initialization, concurrent callers, legacy baselining, partial-schema refusal, transaction rollback/retry, API authentication, unregistered receipt, exact raw preservation, scheduled parsing, dedupe, dynamic labeling, attachments and retention. Synthetic fixtures cover plain text and attachment MIME.

`node scripts/measure-mail.mjs` measures local postal-mime parsing at 0.5, 1, 5 and 20 MiB. These figures describe this machine only; they are not a Cloudflare SLA. C01 (external SMTP routing) and C02 (actual platform failure/retry semantics) require authorized staging resources and remain manual.

Time-sensitive services accept an explicit `now` value; lifecycle tests advance the injected clock rather than waiting. Network delivery should be tested with a controlled HTTPS endpoint returning 2xx, 3xx, 4xx, 429 and 503. Production messages must never become fixtures.

`npm run check` finishes with a Wrangler dry run generated from deterministic non-production values; it does not require a committed configuration or Cloudflare credentials. Actual dashboard deployment, DNS, Email Routing and real-mail behavior remain `MANUAL_PENDING` without authorized resources.
