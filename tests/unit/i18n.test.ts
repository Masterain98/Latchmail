import { describe, expect, it } from "vitest";
import { detectLocale } from "../../src/web/i18n";

describe("locale detection", () => {
  it("selects Chinese when any preferred browser language is Chinese", () => {
    expect(detectLocale(["ja-JP", "zh-Hant-TW", "en-US"])).toBe("zh-CN");
  });

  it("falls back to English for other or missing languages", () => {
    expect(detectLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });
});
