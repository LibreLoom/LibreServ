import { describe, expect, it, vi } from "vitest";
import { submitBatch } from "./submitBatch.js";

describe("submitBatch", () => {
  it("submits every item in order", async () => {
    const seen = [];
    await submitBatch([1, 2, 3], async (item) => {
      seen.push(item);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("does nothing for an empty batch", async () => {
    const submit = vi.fn();
    await submitBatch([], submit);
    expect(submit).not.toHaveBeenCalled();
  });

  it("stops at the first failure and says what is still waiting", async () => {
    const submit = vi.fn(async (item) => {
      if (item === "b") throw new Error("disk full");
    });
    const error = await submitBatch(["a", "b", "c"], submit).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("disk full");
    // The failed item and everything after it can be retried; "a" is done.
    expect(error.pendingItems).toEqual(["b", "c"]);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("wraps a thrown non-error value", async () => {
    const error = await submitBatch(["x"], async () => {
      throw "plain string";
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("plain string");
    expect(error.pendingItems).toEqual(["x"]);
  });
});
