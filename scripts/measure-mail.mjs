import PostalMime from "postal-mime";
const sizes = [0.5, 1, 5, 20];
for (const mib of sizes) {
  const body = "x".repeat(Math.floor(mib * 1024 * 1024));
  const raw = new TextEncoder().encode(
    `From: fixture@example.net\r\nTo: test@example.com\r\nSubject: ${mib} MiB synthetic body\r\nMessage-ID: <fixture-${mib}@example.net>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  );
  const started = performance.now();
  const parsed = await PostalMime.parse(raw);
  const elapsed = performance.now() - started;
  console.log(
    JSON.stringify({
      input_mib: mib,
      raw_bytes: raw.byteLength,
      parse_ms: Number(elapsed.toFixed(1)),
      text_bytes: new TextEncoder().encode(parsed.text ?? "").byteLength,
      attachments: parsed.attachments.length,
    }),
  );
}
