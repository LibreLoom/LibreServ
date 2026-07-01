import { describe, it, expect } from "vitest";
import { plainWebAuthnError } from "./webauthn";

// PlainWebAuthnError must never surface the raw DOMException text to users
// (e.g. "The request is not allowed by the user agent or the platform in the
// current context, possibly because the user denied permission."). It maps
// WebAuthn error names to plain-language, actionable messages.
function domErr(name, message) {
  const e = new Error(message || name);
  e.name = name;
  return e;
}

describe("plainWebAuthnError", () => {
  it("turns NotAllowedError into a plain, actionable message (no raw text)", () => {
    const msg = plainWebAuthnError(
      domErr(
        "NotAllowedError",
        "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
      ),
      "Passkey",
    );
    expect(msg).toMatch(/cancelled|blocked/i);
    expect(msg).not.toMatch(/user agent|platform in the current context/i);
  });

  it("turns SecurityError into a secure-connection hint", () => {
    const msg = plainWebAuthnError(domErr("SecurityError", "operation insecure"), "Passkey");
    expect(msg).toMatch(/secure connection|HTTPS/i);
  });

  it("turns NotSupportedError into a 'try a different method' hint", () => {
    const msg = plainWebAuthnError(domErr("NotSupportedError"), "Security key");
    expect(msg).toMatch(/can't use|different method/i);
  });

  it("turns AbortError into a timeout/cancel message", () => {
    const msg = plainWebAuthnError(domErr("AbortError"), "Passkey");
    expect(msg).toMatch(/too long|cancelled/i);
  });

  it("falls back to a generic plain message for unknown errors", () => {
    const msg = plainWebAuthnError(new Error("something exotic"), "Passkey");
    expect(msg).toMatch(/couldn't finish setting up|different method/i);
    expect(msg).not.toMatch(/something exotic/);
  });

  it("mentions the friendly method label", () => {
    expect(plainWebAuthnError(domErr("NotAllowedError"), "Passkey")).toMatch(/passkey/i);
    expect(plainWebAuthnError(new Error("exotic"), "Security key")).toMatch(/security key/i);
  });
});