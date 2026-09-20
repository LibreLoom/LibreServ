import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EMAIL_VERIFIED_CHANNEL,
  EMAIL_VERIFIED_STORAGE_KEY,
  listenForEmailVerifiedCrossTab,
  notifyEmailVerifiedCrossTab,
} from "./emailVerifiedSync.js";

describe("emailVerifiedSync", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifies listeners via BroadcastChannel when supported", async () => {
    if (typeof BroadcastChannel === "undefined") return;
    const handler = vi.fn();
    const listener = new BroadcastChannel(EMAIL_VERIFIED_CHANNEL);
    listener.onmessage = () => handler();
    notifyEmailVerifiedCrossTab();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    listener.close();
  });

  it("notifies listeners via storage events", () => {
    const handler = vi.fn();
    const stop = listenForEmailVerifiedCrossTab(handler);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EMAIL_VERIFIED_STORAGE_KEY,
        newValue: "1",
        storageArea: localStorage,
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
  });

  it("uses the shared channel name", () => {
    expect(EMAIL_VERIFIED_CHANNEL).toBe("luna-connect-email-verified");
  });
});
