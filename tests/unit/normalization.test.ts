import { describe, expect, it } from "vitest";
import {
  normalizeAddress,
  normalizeDomain,
  normalizeEnvelopeAddress,
  normalizeLocalPart,
  normalizeTag,
  safeDownloadName,
} from "../../src/shared/normalization";

describe("normalization", () => {
  it("normalizes domains and complete addresses without plus/dot folding", () => {
    expect(normalizeDomain("Mail.Example.COM.")).toBe("mail.example.com");
    expect(normalizeAddress("ASUS+Shop@Example.com")).toBe(
      "asus+shop@example.com",
    );
    expect(normalizeAddress("a.sus@example.com")).not.toBe(
      normalizeAddress("asus@example.com"),
    );
  });
  it("keeps envelope validation separate from the ASCII registration UI", () => {
    expect(() => normalizeLocalPart("用户")).toThrow();
    expect(normalizeEnvelopeAddress("用户@Example.com")).toEqual({
      address: "用户@example.com",
      domain: "example.com",
    });
  });
  it("normalizes tag keys and download filenames", () => {
    expect(normalizeTag("  ＡＳＵＳ  ")).toEqual({
      name: "ＡＳＵＳ",
      key: "ａｓｕｓ",
    });
    expect(safeDownloadName("..\\bad\r\nname.exe")).not.toMatch(/[\\\r\n]/);
  });
});
