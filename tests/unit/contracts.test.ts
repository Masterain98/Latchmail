import { describe, expect, it } from "vitest";
import {
  settingsPatchSchema,
  webhookPutSchema,
} from "../../src/shared/contracts";
import { backoffMs } from "../../src/worker/webhooks/service";

describe("bounded contracts", () => {
  it("enforces retention bounds", () => {
    expect(
      settingsPatchSchema.safeParse({ attachment_retention_days: 0 }).success,
    ).toBe(false);
    expect(
      settingsPatchSchema.parse({ attachment_retention_days: 3650 })
        .attachment_retention_days,
    ).toBe(3650);
  });
  it("requires explicit webhook fields and freezes retry schedule", () => {
    expect(
      webhookPutSchema.safeParse({
        enabled: true,
        url: "https://hooks.example.com",
      }).success,
    ).toBe(true);
    expect(backoffMs).toEqual([
      60000, 300000, 900000, 3600000, 10800000, 21600000, 43200000,
    ]);
  });
});
