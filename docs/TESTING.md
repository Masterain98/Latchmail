# Testing

Commands are defined in `package.json`: `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `build`, and aggregate `check`. Unit tests cover normalization, plus/dot identity, envelope/registration boundary, contracts, sessions and retry constants. Workers-runtime integration tests apply real D1 migrations and use Miniflare D1/R2 to cover API authentication, unregistered receipt, exact raw preservation, scheduled parsing, concurrent-safe dedupe identity, dynamic post-receive labeling, duplicate attachment names, distinct hashes, logical expiry and physical raw/attachment cleanup while retaining structured content. Synthetic fixtures cover plain text and attachment MIME.

`node scripts/measure-mail.mjs` measures local postal-mime parsing at 0.5, 1, 5 and 20 MiB. These figures describe this machine only; they are not a Cloudflare SLA. C01 (external SMTP routing) and C02 (actual platform failure/retry semantics) require authorized staging resources and remain manual.

Time-sensitive services accept an explicit `now` value; lifecycle tests advance the injected clock rather than waiting. Network delivery should be tested with a controlled HTTPS endpoint returning 2xx, 3xx, 4xx, 429 and 503. Production messages must never become fixtures.
