import { afterEach, describe, expect, it, vi } from "vitest";
import { canonical, decrypt, derive, newEntropy, SIG_PUBLIC_LEN, verify } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { buildPhraseBody, createIdentity, fromBase64, signFreshChallenge, toBase64 } from "./cloudPhrase";

const LUNA_ID = "luna-test-1";
const USER_ID = "42";
const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

const SIGNING_PUBLIC = new Uint8Array(SIG_PUBLIC_LEN).map((_, i) => (i + 1) % 256);

describe("buildPhraseBody", () => {
  it("sends public keys and a self_sealed copy of the signing public key", () => {
    const entropy = newEntropy();
    const keys = derive(entropy, LUNA_ID);
    const body = buildPhraseBody(entropy, {
      lunaId: LUNA_ID,
      userId: USER_ID,
      signingPublic: toBase64(SIGNING_PUBLIC),
    });

    expect(fromBase64(body.seal_public)).toHaveLength(1216);
    expect(fromBase64(body.auth_public)).toHaveLength(SIG_PUBLIC_LEN);
    expect(fromBase64(body.seal_public)).toEqual(keys.sealPublic);
    expect(fromBase64(body.auth_public)).toEqual(keys.authPublic);
    expect(body).not.toHaveProperty("signature");

    const aad = canonical([
      ["luna_id", encoder.encode(LUNA_ID)],
      ["user_id", encoder.encode(USER_ID)],
      ["purpose", encoder.encode("signing-public")],
    ]);
    const opened = decrypt(keys.selfKey, aad, fromBase64(body.self_sealed));
    expect(opened).toEqual(SIGNING_PUBLIC);
  });

  it("refuses a signing public key that is not 32 bytes", () => {
    expect(() =>
      buildPhraseBody(newEntropy(), { lunaId: LUNA_ID, userId: USER_ID, signingPublic: toBase64(new Uint8Array(5)) }),
    ).toThrow();
  });

});

describe("createIdentity", () => {
  it("POSTs an empty body to the identity route and returns luna_id and signing_public", async () => {
    const sent = {};
    vi.stubGlobal("fetch", vi.fn(async (path, options) => {
      sent.path = String(path);
      sent.method = options.method;
      sent.body = JSON.parse(options.body);
      return new Response(JSON.stringify({ luna_id: LUNA_ID, signing_public: toBase64(SIGNING_PUBLIC) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const result = await createIdentity();

    expect(sent).toEqual({ path: "/api/v1/cloud/identity", method: "POST", body: {} });
    expect(result).toEqual({ luna_id: LUNA_ID, signing_public: toBase64(SIGNING_PUBLIC) });
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
