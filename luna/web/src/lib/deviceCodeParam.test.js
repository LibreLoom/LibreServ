import { describe, expect, it } from "vitest";
import {
  DEVICE_CODE_PARAM,
  readDeviceCodeFromSearch,
  stripDeviceCodeFromSearch,
} from "./deviceCodeParam.js";

describe("deviceCodeParam", () => {
  it("reads a trimmed token from the query string", () => {
    expect(readDeviceCodeFromSearch("?token=ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(readDeviceCodeFromSearch("token=%20ABCD-EFGH%20")).toBe("ABCD-EFGH");
    expect(readDeviceCodeFromSearch(new URLSearchParams("token=XYZ"))).toBe("XYZ");
  });

  it("returns empty when the token param is missing", () => {
    expect(readDeviceCodeFromSearch("")).toBe("");
    expect(readDeviceCodeFromSearch("?foo=1")).toBe("");
    expect(readDeviceCodeFromSearch(null)).toBe("");
  });

  it("strips the token param and leaves other params", () => {
    const next = stripDeviceCodeFromSearch("?token=SECRET&step=account");
    expect(next.get(DEVICE_CODE_PARAM)).toBeNull();
    expect(next.get("step")).toBe("account");
  });
});
