import { describe, it, expect, vi, beforeEach } from "vitest";
import api, { AuthError, apiErrorMessage, setCsrfToken } from "./api";

beforeEach(() => {
  vi.restoreAllMocks();
  setCsrfToken(null);
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: true,
      status: 200,
    }));

    await api("/apps");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/apps",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("passes through options and headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: true,
      status: 200,
    }));

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
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: false,
      status: 404,
    }));

    await expect(api("/missing")).rejects.toThrow(
      "Request failed with status: 404",
    );
  });

  it("extracts message from a flat { error: string } body", async () => {
    const body = { error: "username already exists" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: false,
      status: 409,
      clone: () => ({ json: () => Promise.resolve(body) }),
    }));

    await expect(api("/users", { method: "POST" })).rejects.toThrow(
      "username already exists",
    );
  });

  it("extracts message from a structured { error: { message } } body", async () => {
    const body = {
      success: false,
      error: { code: "FORBIDDEN", message: "You don't have permission to do that" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: false,
      status: 403,
      clone: () => ({ json: () => Promise.resolve(body) }),
    }));

    // Must not surface "[object Object]".
    await expect(api("/users")).rejects.toThrow(
      "You don't have permission to do that",
    );
  });

  it("returns response on success", async () => {
    const mockRes = /** @type {any} */ ({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockRes);

    const res = await api("/health");
    expect(res).toBe(mockRes);
  });

  it("skips refresh for auth endpoints", async () => {
    const refreshSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(/** @type {any} */ ((url, _opts) => {
      if (url === "/api/v1/auth/login") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      refreshSpy(url);
      return Promise.resolve({ ok: true, status: 200 });
    }));

    await expect(
      api("/auth/login", { method: "POST", body: "{}" }),
    ).rejects.toThrow("Request failed with status: 401");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("skips refresh when noRetry option set", async () => {
    const refreshSpy = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(/** @type {any} */ ((url) => {
      if (url === "/api/v1/apps") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      refreshSpy(url);
      return Promise.resolve({ ok: true, status: 200 });
    }));

    await expect(api("/apps", { noRetry: true })).rejects.toThrow(
      "Request failed with status: 401",
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("attempts refresh on 401 and retries", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(/** @type {any} */ ((url) => {
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
    }));

    const res = await api("/apps");
    expect(res.ok).toBe(true);
  });

  it("throws AuthError when refresh fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(/** @type {any} */ ((url) => {
      if (url === "/api/v1/apps") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (url === "/api/v1/auth/refresh") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    }));

    await expect(api("/apps")).rejects.toThrow(
      "Session expired. Please log in again.",
    );
  });

  it("throws AuthError on refresh network error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(/** @type {any} */ ((url) => {
      if (url === "/api/v1/apps") {
        return Promise.resolve({ ok: false, status: 401 });
      }
      if (url === "/api/v1/auth/refresh") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({ ok: true, status: 200 });
    }));

    await expect(api("/apps")).rejects.toThrow(
      "Session expired. Please log in again.",
    );
  });

  it("auto-attaches X-CSRF-Token on mutating requests", async () => {
    setCsrfToken("csrf-abc");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: true,
      status: 200,
    }));

    await api("/network/ddns/update-now", { method: "POST" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/network/ddns/update-now",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-abc" }),
      }),
    );
  });

  it("does not overwrite an explicit X-CSRF-Token header", async () => {
    setCsrfToken("csrf-abc");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: true,
      status: 200,
    }));

    await api("/settings", {
      method: "PUT",
      headers: { "X-CSRF-Token": "explicit-tok" },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/settings",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRF-Token": "explicit-tok" }),
      }),
    );
  });

  it("maps opaque NetworkError to plain language", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("NetworkError when attempting to fetch resource."),
    );

    await expect(api("/apps")).rejects.toThrow(
      "Couldn't reach LibreServ. Check this device's connection and try again.",
    );
  });

  it("rewrites CSRF 403s to a refresh hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(/** @type {any} */ ({
      ok: false,
      status: 403,
      clone: () => ({
        json: () => Promise.resolve({ error: "CSRF token is required" }),
      }),
    }));

    await expect(api("/settings", { method: "PUT" })).rejects.toThrow(
      "This page expired. Refresh LibreServ and try again.",
    );
  });
});

describe("apiErrorMessage", () => {
  it("rewrites opaque browser network failures", () => {
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach LibreServ. Check this device's connection and try again.",
    );
  });
});

