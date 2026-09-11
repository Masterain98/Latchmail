import { describe, expect, it } from "vitest";
import { createSession, verifySession } from "../../src/worker/auth/session";

describe("signed session", () => {
  const secret = "independent-session-secret-that-is-long-enough";
  it("round trips and derives a csrf token", async () => {
    const session = await createSession(secret, 1000);
    await expect(verifySession(secret, session.token, 2000)).resolves.toEqual({
      csrf: session.csrf,
    });
  });
  it("rejects expiry and tampering", async () => {
    const session = await createSession(secret, 1000);
    await expect(
      verifySession(secret, session.token, 8 * 86400000),
    ).resolves.toBeNull();
    await expect(
      verifySession(secret, `${session.token}x`, 2000),
    ).resolves.toBeNull();
  });
});
