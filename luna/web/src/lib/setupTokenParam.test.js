import { describe, expect, it } from "vitest";
import {
  SETUP_TOKEN_PARAM,
  hasSetupTokenInHash,
  readSetupTokenFromHash,
  stripSetupTokenFromHash,
} from "./setupTokenParam.js";

describe("setup token fragment", () => {
  it("reads and trims the token from the fragment", () => {
    expect(readSetupTokenFromHash("#token=%207K4M-2Q9X-R8N3-6T5W-1PZH%20")).toBe("7K4M-2Q9X-R8N3-6T5W-1PZH");
    expect(readSetupTokenFromHash(`#${SETUP_TOKEN_PARAM}=abc`)).toBe("abc");
  });

  it("recognizes an empty token fragment so Setup can still remove it", () => {
    expect(hasSetupTokenInHash("#token=")).toBe(true);
    expect(readSetupTokenFromHash("#token=")).toBe("");
  });

  it("never accepts a token from the query string", () => {
    expect(hasSetupTokenInHash("?token=abc")).toBe(false);
    expect(readSetupTokenFromHash("?token=abc")).toBe("");
    expect(readSetupTokenFromHash("#other=1")).toBe("");
    expect(readSetupTokenFromHash(null)).toBe("");
  });

  it("removes only the token and preserves other fragment values", () => {
    expect(stripSetupTokenFromHash("#token=secret&step=account")).toBe("#step=account");
    expect(stripSetupTokenFromHash("#token=secret")).toBe("");
    expect(stripSetupTokenFromHash("")).toBe("");
  });
});
