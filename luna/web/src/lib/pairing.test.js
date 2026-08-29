import { describe, it, expect } from "vitest";
import { encodePairing, decodePairing } from "./pairing.js";

describe("pairing QR payload", () => {
  it("round-trips address and token", () => {
    const encoded = encodePairing("http://luna.local/", "tok-abc");
    expect(encoded.startsWith("luna://pair?")).toBe(true);
    expect(decodePairing(encoded)).toEqual({
      url: "http://luna.local",
      token: "tok-abc",
    });
  });

  it("encodes reserved characters in the token", () => {
    const encoded = encodePairing("http://192.168.1.20:8090", "a+b/c=&x");
    expect(decodePairing(encoded)).toEqual({
      url: "http://192.168.1.20:8090",
      token: "a+b/c=&x",
    });
  });

  it("accepts a JSON payload from other scanners", () => {
    expect(decodePairing('{"url":"http://luna.local/","token":"xyz"}')).toEqual({
      url: "http://luna.local",
      token: "xyz",
    });
  });

  it("rejects incomplete or foreign payloads", () => {
    expect(decodePairing("https://example.com")).toBeNull();
    expect(decodePairing("luna://pair?url=http://luna.local")).toBeNull();
    expect(decodePairing("luna://other?url=http://luna.local&token=x")).toBeNull();
    expect(decodePairing("")).toBeNull();
  });
});
