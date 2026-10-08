// A big upload goes up in chunks. When the connection drops part-way (Wi-Fi
// gap, router restart, a phone going to sleep) the server still has every chunk
// it acknowledged, and writing the same range again is harmless, so one chunk is
// simply sent again after a pause instead of throwing the whole upload away.

/** Pauses between tries, in milliseconds (about two minutes in all). */
export const CHUNK_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 15000, 30000, 30000];

/**
 * Worth trying again: no answer at all, or a server that is busy or restarting.
 * Not worth it: "this drive is full" (507) or anything the person must fix.
 * @param {unknown} err
 */
export function isTransientUploadError(err) {
  const status = /** @type {{ name?: string, status?: number }} */ (err)?.status;
  if (/** @type {{ name?: string }} */ (err)?.name !== "ApiError" || typeof status !== "number") {
    return false;
  }
  return status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/** @param {number} ms @param {AbortSignal} [signal] */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `send` (one chunk), trying again through a dropped connection.
 * @template T
 * @param {() => Promise<T>} send
 * @param {{ signal?: AbortSignal, delays?: number[], wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>, onRetry?: (attempt: number) => void }} [options]
 * @returns {Promise<T>}
 */
export async function sendChunkWithRetry(send, { signal, delays = CHUNK_RETRY_DELAYS_MS, wait = pause, onRetry } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      if (attempt >= delays.length || !isTransientUploadError(err)) throw err;
      onRetry?.(attempt + 1);
      await wait(delays[attempt], signal);
    }
  }
}
