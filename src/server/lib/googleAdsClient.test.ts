import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleAdsClient } from "./googleAdsClient";
import { GoogleAdsTokenError } from "./googleAdsErrors";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: mocks.getAccessToken } }),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: () => Promise.resolve("developer-token"),
}));

const client = () =>
  createGoogleAdsClient({ userId: "user_1", googleAdsAccountId: "account_1" });

describe("createGoogleAdsClient access token", () => {
  beforeEach(() => {
    mocks.getAccessToken.mockResolvedValue({ accessToken: "ads_tok" });
    // A fresh Response per call: a body can only be read once.
    mocks.fetch.mockImplementation(() =>
      Promise.resolve(
        Response.json({ resourceNames: ["customers/1234567890"] }),
      ),
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("mints one token for concurrent requests", async () => {
    const ads = client();
    await Promise.all([
      ads.listAccessibleCustomers(),
      ads.listAccessibleCustomers(),
    ]);
    expect(mocks.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed mint instead of failing every later request", async () => {
    mocks.getAccessToken
      .mockRejectedValueOnce(new Error("transient refresh failure"))
      .mockResolvedValue({ accessToken: "ads_tok" });
    const ads = client();
    await expect(ads.listAccessibleCustomers()).rejects.toBeInstanceOf(
      GoogleAdsTokenError,
    );
    await expect(ads.listAccessibleCustomers()).resolves.toEqual([
      "1234567890",
    ]);
  });
});
