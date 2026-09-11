import { readFile } from "node:fs/promises";
const [
  path = "tests/fixtures/plain.eml",
  from = "sender@example.net",
  to = "random@example.com",
  origin = "http://127.0.0.1:8787",
] = process.argv.slice(2);
const bytes = await readFile(path);
const url = new URL("/cdn-cgi/handler/email", origin);
url.searchParams.set("from", from);
url.searchParams.set("to", to);
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "message/rfc822" },
  body: bytes,
});
console.log(`HTTP ${response.status}`);
if (!response.ok) {
  console.error(await response.text());
  process.exitCode = 1;
}
