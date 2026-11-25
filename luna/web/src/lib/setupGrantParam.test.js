import { describe, expect, it } from "vitest";
import {
  SETUP_GRANT_PARAM,
  hasSetupGrantInHash,
  readSetupGrantFromHash,
  stripSetupGrantFromHash,
} from "./setupGrantParam.js";

describe("setup grant fragment", () => {
  it("reads and trims the grant from the fragment", () => {
    expect(readSetupGrantFromHash("#setup_grant=%20one-time%20")).toBe("one-time");
    expect(readSetupGrantFromHash(`#${SETUP_GRANT_PARAM}=abc`)).toBe("abc");
  });

  it("recognizes an empty grant fragment so Setup can still remove it", () => {
    expect(hasSetupGrantInHash("#setup_grant=")).toBe(true);
    expect(readSetupGrantFromHash("#setup_grant=")).toBe("");
  });

  it("never accepts a grant from the query string", () => {
    expect(hasSetupGrantInHash("?setup_grant=abc")).toBe(false);
    expect(readSetupGrantFromHash("?setup_grant=abc")).toBe("");
    expect(readSetupGrantFromHash("#other=1")).toBe("");
    expect(readSetupGrantFromHash(null)).toBe("");
  });

  it("removes only the grant and preserves other fragment values", () => {
    expect(stripSetupGrantFromHash("#setup_grant=secret&step=account")).toBe("#step=account");
    expect(stripSetupGrantFromHash("#setup_grant=secret")).toBe("");
    expect(stripSetupGrantFromHash("")).toBe("");
  });
});
