import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { canUseClipboard, copyToClipboard, copyWithFeedback } from "./clipboard.js";

describe("clipboard", () => {
  const originalClipboard = navigator.clipboard;
  const originalSecure = window.isSecureContext;

  beforeEach(() => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => originalSecure,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  it("canUseClipboard is true in a secure context with writeText", () => {
    expect(canUseClipboard()).toBe(true);
  });

  it("canUseClipboard is false when not a secure context", () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => false,
    });
    expect(canUseClipboard()).toBe(false);
  });

  it("canUseClipboard is false when clipboard API is missing", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    expect(canUseClipboard()).toBe(false);
  });

  it("copyToClipboard writes text when available", async () => {
    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("copyToClipboard returns false on insecure pages without calling writeText", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => false,
    });
    await expect(copyToClipboard("secret")).resolves.toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copyWithFeedback flips copied state only on success", async () => {
    const setCopied = vi.fn();
    await expect(copyWithFeedback("tok", setCopied)).resolves.toBe(true);
    expect(setCopied).toHaveBeenCalledWith(true);
  });

  it("copyWithFeedback does not flip state when insecure", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => false,
    });
    const setCopied = vi.fn();
    await expect(copyWithFeedback("tok", setCopied)).resolves.toBe(false);
    expect(setCopied).not.toHaveBeenCalled();
  });
});
