import { afterEach, describe, expect, it, vi } from "vitest";
import { AHEAD_MAX_AGE_MS, clearListingAhead, fetchListingAhead, takeListingPage } from "./listingAhead.js";

afterEach(() => {
  clearListingAhead();
  vi.useRealTimers();
});

describe("listing look-ahead", () => {
  it("hands over a page fetched ahead without asking again", async () => {
    const fetcher = vi.fn(async (url) => ({ url }));
    fetchListingAhead("/p?offset=80", fetcher);
    await expect(takeListingPage("/p?offset=80", fetcher)).resolves.toEqual({ url: "/p?offset=80" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("joins a look-ahead still on its way", async () => {
    let finish = (/** @type {any} */ _v) => {};
    const fetcher = vi.fn(() => new Promise((r) => (finish = r)));
    fetchListingAhead("/p?offset=80", fetcher);
    const page = takeListingPage("/p?offset=80", fetcher);
    finish({ items: [1] });
    await expect(page).resolves.toEqual({ items: [1] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses a kept page once", async () => {
    const fetcher = vi.fn(async () => ({}));
    fetchListingAhead("/p?offset=80", fetcher);
    await takeListingPage("/p?offset=80", fetcher);
    await takeListingPage("/p?offset=80", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("drops kept pages when the first page is fetched again", async () => {
    const fetcher = vi.fn(async () => ({}));
    fetchListingAhead("/p?offset=80", fetcher);
    await takeListingPage("/p?offset=0", fetcher, { first: true });
    await takeListingPage("/p?offset=80", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("asks again when the look-ahead failed", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
    fetchListingAhead("/p?offset=80", fetcher);
    await expect(takeListingPage("/p?offset=80", fetcher)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not use a page kept too long", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => ({}));
    fetchListingAhead("/p?offset=80", fetcher);
    vi.advanceTimersByTime(AHEAD_MAX_AGE_MS + 1);
    await takeListingPage("/p?offset=80", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
