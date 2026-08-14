import { describe, expect, it } from "vitest";
import { normalizeMarketplaceRegistrationRecord } from "../src/util/plugin-marketplace-descriptor.js";

describe("plugin marketplace descriptor normalization", () => {
  it("ignores authentic outer metadata while validating recognized options and inner descriptors", () => {
    expect(normalizeMarketplaceRegistrationRecord({
      autoUpdate: false,
      installLocation: "/imported/marketplace",
      lastUpdated: "2025-01-02T03:04:05.000Z",
      source: { source: "github", repo: "owner/catalog", ref: "main", skipLfs: true },
    }, "user")).toMatchObject({ validity: "valid", descriptor: { kind: "github", repo: "owner/catalog", ref: "main" } });
    for (const value of [
      { autoUpdate: "false", source: { source: "github", repo: "owner/catalog" } },
      { source: { source: "github", repo: "owner/catalog", skipLfs: "true" } },
      { source: { source: "github", repo: "owner/catalog", token: "SECRET_CANARY" } },
    ]) expect(normalizeMarketplaceRegistrationRecord(value, "user")).toEqual({ validity: "invalid" });
  });
});
