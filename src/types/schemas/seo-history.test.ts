import { describe, expect, it } from "vitest";
import { parseSeoHistoryPayload } from "./seo-history";

describe("seo history payload schemas", () => {
  it("accepts a map-pack snapshot", () => {
    expect(
      parseSeoHistoryPayload("map_pack", {
        query: "dui lawyer near me",
        results: [{ name: "Law Office of Tony Swartz", rank: 3, reviews: 40 }],
      }),
    ).toMatchObject({ query: "dui lawyer near me" });
  });

  it("rejects an empty map-pack query", () => {
    expect(() =>
      parseSeoHistoryPayload("map_pack", { query: "", results: [] }),
    ).toThrow();
  });

  it("accepts GSC totals", () => {
    expect(
      parseSeoHistoryPayload("gsc_totals", {
        clicks: 120,
        impressions: 4000,
        ctr: 0.03,
        position: 12.4,
      }),
    ).toMatchObject({ clicks: 120, impressions: 4000 });
  });
});
