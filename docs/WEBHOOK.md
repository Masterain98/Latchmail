[English](WEBHOOK.md) · [简体中文](WEBHOOK_CN.md)

# Webhook protocol 1.0

Every request is `POST multipart/form-data` with exactly `payload` (`application/json; charset=utf-8`) and `raw_email` (`message/rfc822`). The JSON bytes and EML bytes are immutable across retries; only the random boundary, timestamp and signature change. Attachments are already contained in the EML and are not duplicated as extra parts.

Headers: `X-Inbox-Event-Id`, `X-Inbox-Delivery-Id`, `X-Inbox-Timestamp`, `X-Inbox-Payload-SHA256`, and `X-Inbox-Signature: v1,<base64>`. Decode the configured standard-Base64 32-byte key and HMAC-SHA256 the UTF-8 string `event_id.delivery_id.timestamp.payload_sha256`. Verify the raw payload bytes before JSON parsing, require a timestamp within five minutes, match the event ID, then stream-check raw size/SHA-256 from the authenticated payload.

Any 2xx succeeds. Network errors, timeouts, 408, 425, 429 and 5xx retry. Redirects are never followed; other 4xx terminate the automatic cycle. Backoff is 1m, 5m, 15m, 1h, 3h, 6h and 12h with small jitter, at most eight attempts and at most 24 hours or raw expiry. Duplicate delivery is possible after an uncertain response; receivers must make `event_id` idempotent.

Run the sample with `WEBHOOK_SIGNING_SECRET=<base64-32-bytes> node examples/webhook-receiver/server.mjs`. It validates both parts, signature and raw integrity, persists only bounded metadata/payload in `examples/webhook-receiver/data`, and returns 2xx for duplicate event IDs. Put it behind HTTPS for real Worker delivery.
