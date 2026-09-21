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

  it("canUseClipboard is false on insecure pages", () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => false,
    });
    expect(canUseClipboard()).toBe(false);
  });

  it("copyToClipboard does not pretend success when insecure", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => false,
    });
    const onError = vi.fn();
    await expect(copyToClipboard("x", { onError, suppressHaptic: true })).resolves.toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("copyWithFeedback sets copied only when write succeeds", async () => {
    const setCopied = vi.fn();
    await expect(copyWithFeedback("tok", setCopied, { suppressHaptic: true })).resolves.toBe(true);
    expect(setCopied).toHaveBeenCalledWith(true);
  });
});
