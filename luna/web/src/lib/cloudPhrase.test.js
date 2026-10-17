import { afterEach, describe, expect, it, vi } from "vitest";
import { canonical, decrypt, derive, newEntropy, verify } from "./backupCrypto";
import { buildPhraseBody, fromBase64, signFreshChallenge, toBase64 } from "./cloudPhrase";

const LUNA_ID = "luna-test-1";
const USER_ID = "42";
const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPhraseBody", () => {
  it("sends 32-byte public keys and a self_sealed copy of the auth public key", () => {
    const entropy = newEntropy();
    const keys = derive(entropy, LUNA_ID);
    const body = buildPhraseBody(entropy, { lunaId: LUNA_ID, userId: USER_ID });

    expect(fromBase64(body.x25519_public)).toHaveLength(32);
    expect(fromBase64(body.auth_public)).toHaveLength(32);
    expect(fromBase64(body.x25519_public)).toEqual(keys.x25519Public);
    expect(fromBase64(body.auth_public)).toEqual(keys.authPublic);
    expect(body).not.toHaveProperty("signature");

    const aad = canonical([
      ["luna_id", encoder.encode(LUNA_ID)],
      ["user_id", encoder.encode(USER_ID)],
    ]);
    const opened = decrypt(keys.selfKey, aad, fromBase64(body.self_sealed));
    expect(opened).toEqual(keys.authPublic);
  });

  it("includes the signature when one is given", () => {
    const entropy = newEntropy();
    const body = buildPhraseBody(entropy, { lunaId: LUNA_ID, userId: USER_ID, signature: "c2ln" });
    expect(body.signature).toBe("c2ln");
  });
});

describe("signFreshChallenge", () => {
  it("signs the server challenge with the derived auth key under the phrase-check domain", async () => {
    const entropy = newEntropy();
    const { authPublic } = derive(entropy, LUNA_ID);
    const challenge = new Uint8Array(32).map((_, i) => i + 1);
    const requested = [];
    const fetchMock = vi.fn(async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ challenge: toBase64(challenge) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const signature = await signFreshChallenge(entropy, LUNA_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requested).toEqual(["/api/v1/cloud/phrase/challenge"]);
    expect(verify(authPublic, "phrase-check", challenge, fromBase64(signature))).toBe(true);
  });
});
