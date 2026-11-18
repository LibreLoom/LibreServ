import { describe, expect, it } from "vitest";
import { INDEXING_REFRESH_MAX_MS, INDEXING_REFRESH_MS, indexingRefreshDelay } from "./photosIndexing.js";

describe("indexingRefreshDelay", () => {
  it("keeps the short wait with one page or none loaded", () => {
    expect(indexingRefreshDelay(1)).toBe(INDEXING_REFRESH_MS);
    expect(indexingRefreshDelay(0)).toBe(INDEXING_REFRESH_MS);
    expect(indexingRefreshDelay(undefined)).toBe(INDEXING_REFRESH_MS);
  });

  it("grows with the pages a refresh has to reload, up to a cap", () => {
    expect(indexingRefreshDelay(3)).toBe(3 * INDEXING_REFRESH_MS);
    expect(indexingRefreshDelay(20)).toBe(INDEXING_REFRESH_MAX_MS);
  });
});
