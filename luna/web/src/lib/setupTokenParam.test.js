import { describe, expect, it, beforeEach } from "vitest";
import {
  SETUP_TOKEN_PARAM,
  SETUP_HANDOFF_TOKEN_KEY,
  readSetupTokenFromSearch,
  stripSetupTokenFromSearch,
  stashSetupHandoffToken,
  peekSetupHandoffToken,
  clearSetupHandoffToken,
  takeSetupHandoffFromSearch,
} from "./setupTokenParam.js";

describe("setupTokenParam", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("reads a trimmed token from the query string", () => {
    expect(readSetupTokenFromSearch("?token=ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(readSetupTokenFromSearch("token=%20ABCD-EFGH%20")).toBe("ABCD-EFGH");
    expect(readSetupTokenFromSearch(new URLSearchParams("token=XYZ"))).toBe("XYZ");
  });

  it("returns empty when the token param is missing", () => {
    expect(readSetupTokenFromSearch("")).toBe("");
    expect(readSetupTokenFromSearch("?foo=1")).toBe("");
    expect(readSetupTokenFromSearch(null)).toBe("");
  });

  it("strips the token param and leaves other params", () => {
    const next = stripSetupTokenFromSearch("?token=SECRET&step=account");
    expect(next.get(SETUP_TOKEN_PARAM)).toBeNull();
    expect(next.get("step")).toBe("account");
  });

  it("stashes and peeks a handoff token in sessionStorage", () => {
    stashSetupHandoffToken("  ABCD-EFGH  ");
    expect(sessionStorage.getItem(SETUP_HANDOFF_TOKEN_KEY)).toBe("ABCD-EFGH");
    expect(peekSetupHandoffToken()).toBe("ABCD-EFGH");
    clearSetupHandoffToken();
    expect(peekSetupHandoffToken()).toBe("");
  });

  it("takeSetupHandoffFromSearch marks a fresh Connect link and stashes the token", () => {
    const first = takeSetupHandoffFromSearch("?token=6XKS-P674-1786-RKKT-62DD");
    expect(first).toEqual({
      token: "6XKS-P674-1786-RKKT-62DD",
      freshFromUrl: true,
    });
    expect(peekSetupHandoffToken()).toBe("6XKS-P674-1786-RKKT-62DD");

    const again = takeSetupHandoffFromSearch("");
    expect(again).toEqual({
      token: "6XKS-P674-1786-RKKT-62DD",
      freshFromUrl: false,
    });
  });
});
