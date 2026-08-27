import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiErrorMessage,
  apiFetch,
  deleteJson,
  postForm,
  postJson,
  putBinary,
  withCsrfHeaders,
} from "./api.js";

beforeEach(() => {
  vi.restoreAllMocks();
  document.cookie = "luna_csrf=; Max-Age=0; Path=/";
});

afterEach(() => {
  document.cookie = "luna_csrf=; Max-Age=0; Path=/";
});

describe("withCsrfHeaders", () => {
  it("adds X-CSRF-Token for mutating methods when the cookie is set", () => {
    document.cookie = "luna_csrf=tok123; Path=/";
    expect(withCsrfHeaders("POST", { Accept: "application/json" })).toEqual({
      Accept: "application/json",
      "X-CSRF-Token": "tok123",
    });
    expect(withCsrfHeaders("PUT")).toEqual({ "X-CSRF-Token": "tok123" });
    expect(withCsrfHeaders("DELETE")).toEqual({ "X-CSRF-Token": "tok123" });
  });

  it("skips CSRF on GET/HEAD", () => {
    document.cookie = "luna_csrf=tok123; Path=/";
    expect(withCsrfHeaders("GET")).toEqual({});
    expect(withCsrfHeaders("HEAD")).toEqual({});
  });
});

describe("apiFetch", () => {
  it("forces credentials and keeps CSRF when Content-Type is also set", async () => {
    document.cookie = "luna_csrf=upload-tok; Path=/";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      /** @type {any} */ (new Response("{}", { status: 200 })),
    );

    await apiFetch("/api/v1/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/uploads",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "upload-tok",
        },
      }),
    );
  });

  it("maps opaque NetworkError to a plain-language ApiError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("NetworkError when attempting to fetch resource."),
    );

    await expect(apiFetch("/api/v1/uploads", { method: "POST" })).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message: "Couldn't reach Luna. Check this device's connection and try again.",
    });
  });
});

describe("postJson / postForm / putBinary / deleteJson", () => {
  it("sends CSRF on JSON POST", async () => {
    document.cookie = "luna_csrf=json-tok; Path=/";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      /** @type {any} */ (
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ),
    );

    await postJson("/api/v1/jobs", { kind: "copy" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/jobs",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-CSRF-Token": "json-tok",
        }),
      }),
    );
  });

  it("does not set Content-Type for multipart FormData posts", async () => {
    document.cookie = "luna_csrf=form-tok; Path=/";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      /** @type {any} */ (
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ),
    );
    const form = new FormData();
    form.append("file", new Blob(["hi"]), "hi.txt");

    await postForm("/api/v1/drives/d1/files/upload", form);

    const opts = fetchSpy.mock.calls[0][1];
    expect(opts.credentials).toBe("include");
    expect(opts.headers["X-CSRF-Token"]).toBe("form-tok");
    expect(opts.headers["Content-Type"]).toBeUndefined();
    expect(opts.body).toBe(form);
  });

  it("sends CSRF and Content-Range on chunked PUT", async () => {
    document.cookie = "luna_csrf=put-tok; Path=/";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      /** @type {any} */ (
        new Response(JSON.stringify({ received: 10 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ),
    );

    await putBinary("/api/v1/uploads/u1", new Blob(["abcdefghij"]), {
      headers: { "Content-Range": "bytes 0-9/10" },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/uploads/u1",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        headers: expect.objectContaining({
          "Content-Range": "bytes 0-9/10",
          "X-CSRF-Token": "put-tok",
        }),
      }),
    );
  });

  it("sends CSRF on DELETE", async () => {
    document.cookie = "luna_csrf=del-tok; Path=/";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      /** @type {any} */ (
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ),
    );

    await deleteJson("/api/v1/users/9");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/v1/users/9",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        headers: expect.objectContaining({ "X-CSRF-Token": "del-tok" }),
      }),
    );
  });

  it("surfaces server CSRF 403 text instead of a generic failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      /** @type {any} */ (
        new Response(
          JSON.stringify({ error: "This page expired. Refresh Luna and try again." }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        )
      ),
    );

    await expect(postJson("/api/v1/jobs", {})).rejects.toMatchObject({
      status: 403,
      message: "This page expired. Refresh Luna and try again.",
    });
  });
});

describe("apiErrorMessage", () => {
  it("keeps ApiError messages", () => {
    expect(apiErrorMessage(new ApiError(403, "Refresh Luna and try again."))).toBe(
      "Refresh Luna and try again.",
    );
  });

  it("rewrites opaque NetworkError strings", () => {
    expect(
      apiErrorMessage(new TypeError("NetworkError when attempting to fetch resource.")),
    ).toBe("Couldn't reach Luna. Check this device's connection and try again.");
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "Couldn't reach Luna. Check this device's connection and try again.",
    );
  });
});
