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
    // jsdom has no BroadcastChannel and Node's global lives in a different
    // realm than module code under vitest, so delivery never crosses. Stub a
    // minimal same-name pub/sub to test the module's wiring, not the platform.
    const channels = new Map();
    class FakeBroadcastChannel {
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        if (!channels.has(name)) channels.set(name, new Set());
        channels.get(name).add(this);
      }
      postMessage(data) {
        for (const ch of channels.get(this.name) ?? []) {
          if (ch !== this && ch.onmessage) {
            queueMicrotask(() => ch.onmessage({ data }));
          }
        }
      }
      close() {
        channels.get(this.name)?.delete(this);
      }
    }
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("notifies listeners via BroadcastChannel when supported", async () => {
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
