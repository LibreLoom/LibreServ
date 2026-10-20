import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import vectors from "../../../../luna/crates/lunad/src/backup/cloud/vectors.json";
import {
  canonical,
  chunkId,
  decrypt,
  derive,
  encrypt,
  encryptWith,
  entropyToPhrase,
  newEntropy,
  open,
  packId,
  phraseToEntropy,
  seal,
  sealWith,
  checkPublicKey,
  SEAL_PUBLIC_LEN,
  SEAL_SECRET_LEN,
  sign,
  signerPublic,
  verify,
} from "./backupCrypto.js";

const hex = (s) => hexToBytes(s);
const LUNA_ID = vectors.luna_id;
const ENTROPY = hex(vectors.entropy);
const KEYS = derive(ENTROPY, LUNA_ID);

describe("vectors.json (byte for byte)", () => {
  it("derives the same phrase and keys", () => {
    expect(entropyToPhrase(ENTROPY)).toBe(vectors.phrase);
    expect(bytesToHex(KEYS.sealSecret)).toBe(vectors.seal_secret);
    expect(bytesToHex(KEYS.sealPublic)).toBe(vectors.seal_public);
    expect(bytesToHex(KEYS.selfKey)).toBe(vectors.self_key);
    expect(bytesToHex(KEYS.authSecret)).toBe(vectors.auth_secret);
    expect(bytesToHex(KEYS.authPublic)).toBe(vectors.auth_public);
  });

  it("reads the phrase back to the same entropy", () => {
    expect(phraseToEntropy(vectors.phrase)).toEqual(ENTROPY);
  });

  it("signs and verifies like the Rust signer", () => {
    const seed = hex(vectors.signer_seed);
    const msg = utf8ToBytes("snapshot record");
    expect(bytesToHex(signerPublic(seed))).toBe(vectors.signer_public);
    const sig = sign(seed, "snapshot", msg);
    expect(bytesToHex(sig)).toBe(vectors.signature);
    expect(verify(hex(vectors.signer_public), "snapshot", msg, sig)).toBe(true);
  });

  it("computes chunk ids, pack ids and canonical bytes", () => {
    const dedupKey = new Uint8Array(32).fill(0xa5);
    expect(bytesToHex(chunkId(dedupKey, utf8ToBytes("luna chunk one")))).toBe(
      vectors.chunk_id,
    );
    expect(bytesToHex(packId(utf8ToBytes("ciphertext bytes")))).toBe(
      vectors.pack_id,
    );
    const bytes = canonical([
      ["luna_id", utf8ToBytes(LUNA_ID)],
      ["protection", utf8ToBytes("p1")],
      ["version", Uint8Array.of(0, 0, 0, 2)],
    ]);
    expect(bytesToHex(bytes)).toBe(vectors.canonical);
  });

  it("reproduces the seal vector", () => {
    const s = vectors.seal;
    const sealed = sealWith(
      hex(s.ephemeral_secret),
      hex(s.mlkem_message),
      hex(s.nonce),
      KEYS.sealPublic,
      hex(s.aad),
      hex(s.msg),
    );
    expect(bytesToHex(sealed)).toBe(s.sealed);
    expect(open(KEYS.sealSecret, hex(s.aad), hex(s.sealed))).toEqual(
      hex(s.msg),
    );
  });

  it("reproduces the encrypt vector", () => {
    const e = vectors.encrypt;
    const sealed = encryptWith(
      hex(e.key),
      hex(e.nonce),
      hex(e.aad),
      hex(e.msg),
    );
    expect(bytesToHex(sealed)).toBe(e.sealed);
    expect(decrypt(hex(e.key), hex(e.aad), hex(e.sealed))).toEqual(hex(e.msg));
  });
});

describe("seal and open", () => {
  it("round trips with random keys", () => {
    const sealed = seal(
      KEYS.sealPublic,
      utf8ToBytes("aad"),
      utf8ToBytes("hello"),
    );
    expect(open(KEYS.sealSecret, utf8ToBytes("aad"), sealed)).toEqual(
      utf8ToBytes("hello"),
    );
  });

  it("rejects the wrong key, wrong aad, tampering and short input", () => {
    const other = derive(new Uint8Array(16).fill(9), LUNA_ID);
    const aad = utf8ToBytes("aad");
    const sealed = seal(KEYS.sealPublic, aad, utf8ToBytes("hello"));
    expect(() => open(other.sealSecret, aad, sealed)).toThrow(
      "This sealed copy could not be opened. It was changed, or it was sealed to a different key.",
    );
    expect(() => open(KEYS.sealSecret, utf8ToBytes("other"), sealed)).toThrow(
      /could not be opened/,
    );
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() => open(KEYS.sealSecret, aad, tampered)).toThrow(
      /could not be opened/,
    );
    expect(() => open(KEYS.sealSecret, aad, sealed.slice(0, 10))).toThrow(
      "This sealed copy is too short to be valid.",
    );
  });

  it("refuses to seal to an unusable public key", () => {
    const bad =
      "This recovery key is not valid. Set up the recovery phrase again.";
    const aad = utf8ToBytes("aad");
    const msg = utf8ToBytes("x");
    // Too short: an X25519-only key.
    expect(() => seal(new Uint8Array(32), aad, msg)).toThrow(bad);
    // X25519 half is the identity point.
    const lowOrder = KEYS.sealPublic.slice();
    lowOrder.fill(0, 0, 32);
    expect(() => seal(lowOrder, aad, msg)).toThrow(bad);
    // ML-KEM half fails the FIPS 203 modulus check.
    const badKem = KEYS.sealPublic.slice();
    badKem[32] = 0xff;
    badKem[33] |= 0x0f;
    expect(() => seal(badKem, aad, msg)).toThrow(bad);
    expect(() => checkPublicKey(KEYS.sealPublic)).not.toThrow();
  });

  it("needs both secrets to open a copy", () => {
    const other = derive(new Uint8Array(16).fill(9), LUNA_ID);
    const aad = utf8ToBytes("aad");
    const sealed = seal(KEYS.sealPublic, aad, utf8ToBytes("hello"));
    const onlyX = KEYS.sealSecret.slice();
    onlyX.set(other.sealSecret.slice(32), 32);
    const onlyK = other.sealSecret.slice();
    onlyK.set(KEYS.sealSecret.slice(32), 32);
    expect(() => open(onlyX, aad, sealed)).toThrow(/could not be opened/);
    expect(() => open(onlyK, aad, sealed)).toThrow(/could not be opened/);
  });

  it("has the documented layout", () => {
    const sealed = seal(
      KEYS.sealPublic,
      utf8ToBytes("aad"),
      utf8ToBytes("hello"),
    );
    expect(sealed.length).toBe(32 + 1088 + 24 + 5 + 16);
    expect(KEYS.sealPublic.length).toBe(SEAL_PUBLIC_LEN);
    expect(KEYS.sealSecret.length).toBe(SEAL_SECRET_LEN);
  });
});

describe("encrypt and decrypt", () => {
  it("round trips and rejects wrong key or aad", () => {
    const key = new Uint8Array(32).fill(7);
    const sealed = encrypt(key, utf8ToBytes("aad"), utf8ToBytes("pack"));
    expect(decrypt(key, utf8ToBytes("aad"), sealed)).toEqual(
      utf8ToBytes("pack"),
    );
    expect(() =>
      decrypt(new Uint8Array(32).fill(8), utf8ToBytes("aad"), sealed),
    ).toThrow(
      "This encrypted data could not be opened. It was changed, or the key is wrong.",
    );
    expect(() => decrypt(key, utf8ToBytes("other"), sealed)).toThrow(
      /could not be opened/,
    );
    expect(() => decrypt(key, utf8ToBytes("aad"), sealed.slice(0, 20))).toThrow(
      "This encrypted data is too short to be valid.",
    );
  });
});

describe("signatures", () => {
  it("verify only under their domain and message", () => {
    const seed = new Uint8Array(32).fill(3);
    const pub = signerPublic(seed);
    const msg = utf8ToBytes("record");
    const sig = sign(seed, "snapshot", msg);
    expect(verify(pub, "snapshot", msg, sig)).toBe(true);
    expect(verify(pub, "other", msg, sig)).toBe(false);
    expect(verify(pub, "snapshot", utf8ToBytes("changed"), sig)).toBe(false);
    expect(
      verify(signerPublic(new Uint8Array(32).fill(4)), "snapshot", msg, sig),
    ).toBe(false);
  });
});

describe("derive", () => {
  it("is bound to the Luna id", () => {
    const other = derive(ENTROPY, "luna-test-2");
    expect(other.sealPublic).not.toEqual(KEYS.sealPublic);
    expect(other.selfKey).not.toEqual(KEYS.selfKey);
    expect(other.authPublic).not.toEqual(KEYS.authPublic);
  });

  it("clamps the X25519 secret", () => {
    expect(KEYS.sealSecret[0] & 7).toBe(0);
    expect(KEYS.sealSecret[31] & 0x80).toBe(0);
    expect(KEYS.sealSecret[31] & 0x40).toBe(0x40);
  });
});

describe("canonical and ids", () => {
  it("is length prefixed and unambiguous", () => {
    expect(canonical([["ab", utf8ToBytes("c")]])).not.toEqual(
      canonical([["a", utf8ToBytes("bc")]]),
    );
  });

  it("gives chunk ids that depend on the key and the chunk", () => {
    const a = chunkId(new Uint8Array(32).fill(1), utf8ToBytes("chunk"));
    expect(a).toEqual(
      chunkId(new Uint8Array(32).fill(1), utf8ToBytes("chunk")),
    );
    expect(a).not.toEqual(
      chunkId(new Uint8Array(32).fill(2), utf8ToBytes("chunk")),
    );
    expect(a).not.toEqual(
      chunkId(new Uint8Array(32).fill(1), utf8ToBytes("other")),
    );
  });
});

describe("recovery phrase", () => {
  it("round trips, ignoring case and extra spaces", () => {
    const phrase = entropyToPhrase(ENTROPY);
    const messy = `  ${phrase.toUpperCase().replaceAll(" ", "   ")}  `;
    expect(phraseToEntropy(messy)).toEqual(ENTROPY);
  });

  it("maps all-zero entropy to the BIP39 vector", () => {
    const phrase = entropyToPhrase(new Uint8Array(16));
    expect(phrase).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(phraseToEntropy(phrase)).toEqual(new Uint8Array(16));
  });

  it("gives plain error sentences", () => {
    const unknown = vectors.phrase.replace("abandon", "lunaxyz");
    expect(() => phraseToEntropy(unknown)).toThrow(
      "That word isn't on the recovery phrase list: lunaxyz",
    );
    expect(() => phraseToEntropy("abandon ".repeat(11) + "abandon")).toThrow(
      "These 12 words don't form a valid recovery phrase. Check each word.",
    );
    expect(() => phraseToEntropy("abandon abandon")).toThrow(
      "Your recovery phrase has 2 words. It needs exactly 12.",
    );
  });

  it("makes 16 random bytes", () => {
    expect(newEntropy()).toHaveLength(16);
    expect(newEntropy()).not.toEqual(newEntropy());
  });
});
