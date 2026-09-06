import { describe, expect, it } from "vitest";
import {
  SETUP_TOKEN_PARAM,
  readSetupTokenFromSearch,
  stripSetupTokenFromSearch,
} from "./setupTokenParam.js";

describe("setupTokenParam", () => {
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
});
