# Repository instructions

- Preserve the receive-only boundary. Do not add compose, reply, forwarding, SMTP, AI, OTP extraction, public mailbox access or multi-user features.
- Unknown addresses on an enabled domain must remain receivable. Address registration controls only current UI labels and notes.
- Store raw EML and immutable structured payloads in private R2. Keep D1 rows bounded.
- Any state-machine change must preserve expired-lease recovery, immutable event IDs and logical expiry checks.
- Never expose an arbitrary R2 key, arbitrary SQL operation or caller-supplied webhook destination.
- Add a new numbered migration after deployment; do not rewrite an applied migration.
- Run `npm run check` before marking local work complete. Cloud account, DNS and real-mail checks must be recorded as `MANUAL_PENDING` when credentials are unavailable.
