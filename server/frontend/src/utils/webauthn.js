// WebAuthn transport helpers.
//
// navigator.credentials.create/get need BufferSource values (ArrayBuffer) for
// fields like `challenge`, `user.id`, and credential ids. JSON can't carry
// ArrayBuffer, so the backend encodes these as base64url strings and the
// frontend must decode them back to ArrayBuffer before calling the browser API.
// The response (attestation/assertion) goes the other way: ArrayBuffer → b64.

/** ArrayBuffer / TypedArray → base64url string, no padding (for sending
 *  assertions/attestations to the backend — go-webauthn uses RawURLEncoding). */
export function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url string → ArrayBuffer (for decoding backend challenge/credential bytes). */
export function b64urlToBuf(b64url) {
  const b64 = String(b64url).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Best-effort: decode a value that MAY be a base64url string into a BufferSource.
// If it's already an ArrayBuffer/TypedArray, pass through; if it's not a string,
// leave it (the browser API will reject if invalid).
function asBuffer(value) {
  if (value == null) return undefined;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value;
  if (typeof value === "string") return b64urlToBuf(value);
  return value;
}

/** Prepare PublicKeyCredentialCreationOptions from the backend (decode buffers). */
export function prepareCreationOptions(options) {
  if (!options) return options;
  const prepped = { ...options };
  prepped.challenge = asBuffer(prepped.challenge);
  if (prepped.user) {
    prepped.user = { ...prepped.user, id: asBuffer(prepped.user.id) };
  }
  if (Array.isArray(prepped.excludeCredentials)) {
    prepped.excludeCredentials = prepped.excludeCredentials.map((c) => ({
      ...c,
      id: asBuffer(c.id),
    }));
  }
  return prepped;
}

/** Prepare PublicKeyCredentialRequestOptions from the backend (decode buffers). */
export function prepareRequestOptions(options) {
  if (!options) return options;
  const prepped = { ...options };
  prepped.challenge = asBuffer(prepped.challenge);
  if (Array.isArray(prepped.allowCredentials)) {
    prepped.allowCredentials = prepped.allowCredentials.map((c) => ({
      ...c,
      id: asBuffer(c.id),
    }));
  }
  return prepped;
}

/**
 * Translate a WebAuthn error (the DOMException thrown by
 * navigator.credentials.create/get) into a plain-language message the user can
 * act on. Raw DOMException messages like "The request is not allowed by the
 * user agent or the platform in the current context, possibly because the
 * user denied permission." are developer-facing and must never reach a user.
 * `label` is the friendly method name ("Passkey" / "Security key") used in text.
 */
export function plainWebAuthnError(err, label = "this method") {
  if (err && typeof err === "object" && typeof err.name === "string") {
    switch (err.name) {
      case "NotAllowedError":
        return `You cancelled the ${label.toLowerCase()} prompt or your browser blocked it. Try again, or pick a different method.`;
      case "AbortError":
        return `That took too long or was cancelled. Try again.`;
      case "SecurityError":
        return `${label} needs a secure connection. Open this page over HTTPS (or on the device itself) and try again.`;
      case "NotSupportedError":
        return `This device can't use ${label.toLowerCase()} here. Try a different method, like an authenticator app.`;
      case "InvalidStateError":
        return `That ${label.toLowerCase()} is already set up. Try a different one.`;
      default:
        // Fall through to the generic message below for unknown names.
        break;
    }
  }
  if (!navigator.onLine) {
    return `You're offline. Check your connection and try again.`;
  }
  return `We couldn't finish setting up ${label.toLowerCase()}. Try again, or pick a different method.`;
}