import { describe, expect, it } from "vitest";
import {
  captureResponseBytes,
  MAX_WEBHOOK_RESPONSE_BYTES,
} from "../../src/worker/webhooks/records";

describe("webhook response records", () => {
  it("captures a complete text response and redacts sensitive preview values", async () => {
    const captured = await captureResponseBytes(
      new Response("token=super-secret value", {
        headers: { "Content-Type": "text/plain" },
      }),
    );
    expect(new TextDecoder().decode(captured.bytes)).toBe(
      "token=super-secret value",
    );
    expect(captured.excerpt).toBe("token=[REDACTED] value");
    expect(captured.contentType).toBe("text/plain");
    expect(captured.truncated).toBe(false);
  });

  it("caps response bodies at 64 KiB and marks truncation", async () => {
    const captured = await captureResponseBytes(
      new Response(new Uint8Array(MAX_WEBHOOK_RESPONSE_BYTES + 1)),
    );
    expect(captured.bytes).toHaveLength(MAX_WEBHOOK_RESPONSE_BYTES);
    expect(captured.truncated).toBe(true);
  });

  it("does not mark an exact 64 KiB response as truncated", async () => {
    const captured = await captureResponseBytes(
      new Response(new Uint8Array(MAX_WEBHOOK_RESPONSE_BYTES)),
    );
    expect(captured.bytes).toHaveLength(MAX_WEBHOOK_RESPONSE_BYTES);
    expect(captured.truncated).toBe(false);
  });
});
