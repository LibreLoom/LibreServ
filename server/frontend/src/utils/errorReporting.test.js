import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assert,
  makeSafe,
  reportError,
  safeGet,
  safeJsonParse,
  setupGlobalErrorHandlers,
  withErrorReporting,
} from "./errorReporting.js";

describe("error reporting utilities", () => {
  beforeEach(() => {
    vi.spyOn(console, "group").mockImplementation(() => {});
    vi.spyOn(console, "groupEnd").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);
  });

  afterEach(() => {
    delete window.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__;
    vi.restoreAllMocks();
  });

  it("reports errors with a stable ID and enriched context", () => {
    const id = reportError(new Error("broken"), { feature: "backups" });

    expect(id).toMatch(/^[A-Z0-9]{9}$/);
    expect(console.group).toHaveBeenCalledWith(
      expect.stringContaining(`Error Report [${id}]`),
    );
    expect(console.error).toHaveBeenCalledWith(
      "Error:",
      expect.objectContaining({ message: "broken" }),
    );
    expect(console.log).toHaveBeenCalledWith(
      "Context:",
      expect.objectContaining({
        feature: "backups",
        errorId: id,
        timestamp: expect.any(String),
        userAgent: expect.any(String),
        url: window.location.href,
      }),
    );
  });

  it("reports and rethrows errors from async wrappers", async () => {
    const succeeds = withErrorReporting(
      async (value) => `saved ${value}`,
      "save",
    );
    await expect(succeeds("settings")).resolves.toBe("saved settings");

    const failure = new Error("offline");
    const fails = withErrorReporting(
      async () => {
        throw failure;
      },
      "sync settings",
    );
    await expect(fails({ private: true }, 7)).rejects.toBe(failure);
    expect(console.log).toHaveBeenLastCalledWith(
      "Context:",
      expect.objectContaining({
        operation: "sync settings",
        args: ["[Object]", "7"],
      }),
    );
  });

  it("makes synchronous functions safe", () => {
    const succeeds = makeSafe((value) => value * 2);
    expect(succeeds(4)).toBe(8);

    function loadSettings() {
      throw new Error("invalid");
    }
    expect(makeSafe(loadSettings, "fallback")()).toBe("fallback");
    expect(console.log).toHaveBeenLastCalledWith(
      "Context:",
      expect.objectContaining({
        operation: "loadSettings",
        type: "sync",
      }),
    );
  });

  it("asserts conditions and reports failures", () => {
    expect(() => assert(true, "fine")).not.toThrow();
    expect(() => assert(false, "missing value")).toThrow("missing value");
    expect(() => assert(0)).toThrow("Assertion failed");
  });

  it("parses JSON or returns a chosen default", () => {
    expect(safeJsonParse('{"enabled":true}')).toEqual({ enabled: true });
    expect(safeJsonParse("not-json", { enabled: false })).toEqual({
      enabled: false,
    });
    expect(safeJsonParse("not-json")).toBeNull();
  });

  it("reads nested properties safely", () => {
    expect(safeGet({ user: { profile: { name: "Ada" } } }, "user.profile.name"))
      .toBe("Ada");
    expect(safeGet({ user: null }, "user.profile.name", "unknown")).toBe(
      "unknown",
    );
    expect(safeGet({ user: {} }, "user.name", "unknown")).toBe("unknown");

    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("blocked");
        },
      },
    );
    expect(safeGet(throwing, "secret", "safe")).toBe("safe");
  });

  it("installs browser and React global error handlers", () => {
    window.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__ = {};
    setupGlobalErrorHandlers();

    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: "promise failed" });
    window.dispatchEvent(rejection);

    const rejectionError = new Event("unhandledrejection");
    Object.defineProperty(rejectionError, "reason", {
      value: new Error("known failure"),
    });
    window.dispatchEvent(rejectionError);

    const browserError = new Event("error");
    Object.assign(browserError, {
      error: new Error("script failed"),
      message: "script failed",
      filename: "app.js",
      lineno: 12,
      colno: 3,
    });
    window.dispatchEvent(browserError);

    const messageOnlyError = new Event("error");
    Object.assign(messageOnlyError, {
      message: "message only",
      filename: "other.js",
      lineno: 1,
      colno: 2,
    });
    window.dispatchEvent(messageOnlyError);

    console.error("React crashed", { component: "Dashboard" });
    console.error("ordinary error");

    expect(console.group).toHaveBeenCalledTimes(5);
  });
});
