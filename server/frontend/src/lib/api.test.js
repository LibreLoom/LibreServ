import { describe, it, expect, vi, beforeEach } from "vitest";
import api, { AuthError } from "./api";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AuthError", () => {
  it("sets name and message", () => {
    const err = new AuthError("session gone");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AuthError");
    expect(err.message).toBe("session gone");
  });
});

describe("api", () => {
  it("prepends /api/v1 to the path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await api("/apps");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/apps",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("passes through options and headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "a" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/auth/login",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("throws on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    await expect(api("/missing")).rejects.toThrow(
      "Request failed with status: 404",
    );
  });

  it("returns response on success", async () => {
    const mockRes = { ok: true, status: 200, json: () => Promise.resolve({}) };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockRes);

    const res = await api("/health");
    expect(res).toBe(mockRes);
  });

  it("skips refresh for auth endpoints", async () => {
    const refreshSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((url, _opts) => {
      if (url === "/api/v1/auth/login") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      refreshSpy(url);
      return Promise.resolve({ ok: true, status: 200 });
    });

    await expect(
      api("/auth/login", { method: "POST", body: "{}" }),
    ).rejects.toThrow("Request failed with status: 401");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("skips refresh when noRetry option set", async () => {
    const refreshSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (url === "/api/v1/apps") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      refreshSpy(url);
      return Promise.resolve({ ok: true, status: 200 });
    });

    await expect(api("/apps", { noRetry: true })).rejects.toThrow(
      "Request failed with status: 401",
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("attempts refresh on 401 and retries", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      callCount++;
      if (url === "/api/v1/apps" && callCount === 1) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (url === "/api/v1/auth/refresh") {
        return Promise.resolve({ ok: true, status: 200 });
      }
      if (url === "/api/v1/apps" && callCount > 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const res = await api("/apps");
    expect(res.ok).toBe(true);
  });

  it("throws AuthError when refresh fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (url === "/api/v1/apps") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (url === "/api/v1/auth/refresh") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    await expect(api("/apps")).rejects.toThrow(
      "Session expired. Please log in again.",
    );
  });

  it("throws AuthError on refresh network error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (url === "/api/v1/apps") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (url === "/api/v1/auth/refresh") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    await expect(api("/apps")).rejects.toThrow(
      "Session expired. Please log in again.",
    );
  });
});
