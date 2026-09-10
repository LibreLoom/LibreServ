import { describe, expect, it, vi, afterEach } from "vitest";
import { probeEuroOffice, EUROOFFICE_API_SRC } from "./euroOfficeApi.js";

describe("probeEuroOffice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects SPA HTML fallback that returns 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        expect(url).toBe(EUROOFFICE_API_SRC);
        if (opts?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response("<!doctype html><html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    );
    await expect(probeEuroOffice()).resolves.toBe(false);
  });

  it("accepts a JavaScript DocsAPI pack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, opts) => {
        if (opts?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        return new Response("window.DocsAPI = {};", {
          status: 206,
          headers: { "content-type": "application/javascript" },
        });
      }),
    );
    await expect(probeEuroOffice()).resolves.toBe(true);
  });
});
