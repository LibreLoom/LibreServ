import { describe, expect, it } from "vitest";
import { connectState, isConnectBound } from "./connectState.js";

describe("Connect UI state", () => {
  it("uses the reported binding, never the presence of a verification code", () => {
    expect(connectState({ paired: false, verification_code: "A3F91C" })).toBe("unbound");
    expect(isConnectBound({ paired: false, connect_active: true, verification_code: "A3F91C" })).toBe(false);
    expect(isConnectBound({ paired: true, connect_active: true })).toBe(true);
  });

  it("keeps pending and revoked states ahead of a stale paired flag", () => {
    expect(connectState({ paired: true, unbind_pending: true })).toBe("pending");
    expect(connectState({ paired: true, state: "revoked" })).toBe("revoked");
    expect(connectState({ state: "revoked", revoked: true, unbind_pending: true })).toBe("revoked");
    expect(isConnectBound({ paired: true, state: "revoked" })).toBe(false);
  });

  it("does not call a binding active when Luna reports no working credential", () => {
    expect(isConnectBound({ paired: true, connect_active: false })).toBe(false);
  });
});
