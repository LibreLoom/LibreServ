import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./api.js";
import { isTransientUploadError, sendChunkWithRetry } from "./uploadRetry.js";

const noWait = () => Promise.resolve();

describe("sendChunkWithRetry", () => {
  it("sends the chunk again after the connection drops, then carries on", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "Couldn't reach Luna."))
      .mockRejectedValueOnce(new ApiError(503, "busy"))
      .mockResolvedValue({ received: 8 });
    const onRetry = vi.fn();
    const result = await sendChunkWithRetry(send, { wait: noWait, onRetry });
    expect(result).toEqual({ received: 8 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last pause", async () => {
    const send = vi.fn().mockRejectedValue(new ApiError(0, "Couldn't reach Luna."));
    await expect(sendChunkWithRetry(send, { wait: noWait, delays: [1, 1] })).rejects.toMatchObject({ status: 0 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry a drive that is full or a refusal", async () => {
    for (const status of [400, 403, 404, 413, 500, 507]) {
      const send = vi.fn().mockRejectedValue(new ApiError(status, "no"));
      await expect(sendChunkWithRetry(send, { wait: noWait })).rejects.toMatchObject({ status });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("stops when the person cancels", async () => {
    const send = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(sendChunkWithRetry(send, { wait: noWait })).rejects.toMatchObject({ name: "AbortError" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(isTransientUploadError(new Error("x"))).toBe(false);
  });
});
