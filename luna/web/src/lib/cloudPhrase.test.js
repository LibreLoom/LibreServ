import { afterEach, describe, expect, it, vi } from "vitest";
import { canonical, decrypt, derive, entropyToPhrase, newEntropy, phraseToEntropy, SIG_PUBLIC_LEN, verify } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { openScopeSecret, sealScopeSecret } from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import {
  buildPhraseBody,
  checkPhraseWords,
  createIdentity,
  fromBase64,
  LOCKED_OUT_MESSAGE,
  normalizePhraseStatus,
  replaceErrorMessage,
  replaceMessage,
  rescopedHash,
  replacePhrase,
  REPLACE_DOMAIN,
  signFreshChallenge,
  toBase64,
} from "./cloudPhrase";

const sealHooks = vi.hoisted(() => ({ corrupt: false }));
vi.mock("@libreloom/ui/lib/cloud/cloudPrivate.js", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    sealScopeSecret: (...args) => {
      const sealed = actual.sealScopeSecret(...args);
      if (!sealHooks.corrupt) return sealed;
      const bad = sealed.slice();
      bad[bad.length - 1] ^= 1;
      return bad;
    },
  };
});

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

/** Routes the phrase endpoints for one test. `handlers` maps "METHOD /path" to a [status, body] or a function. */
function routePhrase(handlers) {
  const calls = [];
  // No private scopes unless a test says otherwise.
  const routes = { "GET /api/v1/cloud/phrase/scopes": [200, { scopes: [] }], ...handlers };
  const fetchMock = vi.fn(async (url, options = {}) => {
    const method = options.method ?? "GET";
    const key = `${method} ${String(url)}`;
    calls.push({ key, body: options.body ? JSON.parse(options.body) : null });
    const handler = routes[key];
    const [status, body] = typeof handler === "function" ? handler(calls.at(-1)) : handler;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const CHALLENGE = new Uint8Array(32).map((_, i) => 200 - i);
const challengeReply = () => [200, { challenge: toBase64(CHALLENGE) }];

describe("replace signing", () => {
  it("signs a fresh challenge under the phrase-replace domain, never under phrase-check", async () => {
    const entropy = newEntropy();
    const { authPublic } = derive(entropy, LUNA_ID);
    routePhrase({ "POST /api/v1/cloud/phrase/challenge": challengeReply });

    const signature = fromBase64(await signFreshChallenge(entropy, LUNA_ID, REPLACE_DOMAIN));

    expect(REPLACE_DOMAIN).toBe("phrase-replace");
    expect(verify(authPublic, "phrase-replace", CHALLENGE, signature)).toBe(true);
    expect(verify(authPublic, "phrase-check", CHALLENGE, signature)).toBe(false);
  });

  it("asks for a new challenge on every attempt, so none is reused", async () => {
    const entropy = newEntropy();
    const { calls } = routePhrase({ "POST /api/v1/cloud/phrase/challenge": challengeReply });

    await signFreshChallenge(entropy, LUNA_ID, REPLACE_DOMAIN);
    await signFreshChallenge(entropy, LUNA_ID, REPLACE_DOMAIN);

    expect(calls.map((c) => c.key)).toEqual([
      "POST /api/v1/cloud/phrase/challenge",
      "POST /api/v1/cloud/phrase/challenge",
    ]);
  });
});

describe("checkPhraseWords", () => {
  const phrase = entropyToPhrase(newEntropy(12));

  it("returns the entropy when Luna accepts the phrase", async () => {
    routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "POST /api/v1/cloud/phrase/check": [200, { ok: true }],
    });
    const entropy = await checkPhraseWords(phrase, LUNA_ID);
    expect(entropy).toEqual(phraseToEntropy(phrase));
  });

  it("refuses a wrong phrase with null (403), so the caller shows the plain message", async () => {
    routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "POST /api/v1/cloud/phrase/check": [403, { error: "No." }],
    });
    expect(await checkPhraseWords(phrase, LUNA_ID)).toBeNull();
  });

  it("refuses a phrase Luna answers with 400 too, since that is how it refuses today", async () => {
    routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "POST /api/v1/cloud/phrase/check": [400, { error: "That doesn't match." }],
    });
    expect(await checkPhraseWords(phrase, LUNA_ID)).toBeNull();
  });

  it("surfaces the lockout message on 429 and does not retry", async () => {
    const { fetchMock } = routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "POST /api/v1/cloud/phrase/check": [429, { error: "slow down" }],
    });
    await expect(checkPhraseWords(phrase, LUNA_ID)).rejects.toThrow(LOCKED_OUT_MESSAGE);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/check"))).toHaveLength(1);
  });

  it("rejects words that are not a phrase before asking the server", async () => {
    const { fetchMock } = routePhrase({});
    await expect(checkPhraseWords("not a phrase at all", LUNA_ID)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("replacePhrase", () => {
  const SIGNING_PUBLIC_B64 = toBase64(new Uint8Array(SIG_PUBLIC_LEN).map((_, i) => (i + 3) % 256));
  const newPhrase = entropyToPhrase(newEntropy(12));
  const common = { newPhrase, lunaId: LUNA_ID, userId: USER_ID, signingPublic: SIGNING_PUBLIC_B64 };

  it("with the old phrase: sends an old_signature proof and exposed false, signed by the old key", async () => {
    const oldEntropy = newEntropy();
    const { authPublic } = derive(oldEntropy, LUNA_ID);
    const { calls } = routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });

    await replacePhrase({ ...common, proof: { oldEntropy }, exposed: false });

    const put = calls.find((c) => c.key === "PUT /api/v1/cloud/phrase").body;
    expect(put.proof).toBe("old_signature");
    expect(put.exposed).toBe(false);
    expect(put).not.toHaveProperty("password");
    const signature = fromBase64(put.signature);
    expect(verify(authPublic, REPLACE_DOMAIN, replaceMessage(CHALLENGE, put), signature)).toBe(true);
    // The signature covers the new keys: it does not hold for a request with any value swapped.
    const other = toBase64(new Uint8Array(32).fill(9));
    for (const changed of [{ seal_public: other }, { auth_public: other }, { self_sealed: other }, { exposed: true }]) {
      expect(verify(authPublic, REPLACE_DOMAIN, replaceMessage(CHALLENGE, { ...put, ...changed }), signature)).toBe(false);
    }
    // And it is not the plain challenge any more.
    expect(verify(authPublic, REPLACE_DOMAIN, CHALLENGE, signature)).toBe(false);
    expect(put.auth_public).toBe(toBase64(derive(phraseToEntropy(newPhrase), LUNA_ID).authPublic));
  });

  it("forwards exposed true as true", async () => {
    const { calls } = routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });
    await replacePhrase({ ...common, proof: { oldEntropy: newEntropy() }, exposed: true });
    expect(calls.find((c) => c.key === "PUT /api/v1/cloud/phrase").body.exposed).toBe(true);
  });

  it("when the phrase is lost: sends the password as the proof, with no signature and no challenge", async () => {
    const { calls } = routePhrase({
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });
    await replacePhrase({ ...common, proof: { password: "hunter2 long" }, exposed: true });

    const put = calls.find((c) => c.key === "PUT /api/v1/cloud/phrase").body;
    expect(calls.map((c) => c.key)).toEqual(["PUT /api/v1/cloud/phrase"]);
    expect(put.proof).toBe("password");
    expect(put.password).toBe("hunter2 long");
    expect(put.exposed).toBe(true);
    expect(put).not.toHaveProperty("signature");
  });

  it("re-seals each scope the old phrase opens to the new phrase, skips one it cannot open, and sends them as rescoped", async () => {
    const oldEntropy = newEntropy();
    const oldKeys = derive(oldEntropy, LUNA_ID);
    const secret = new Uint8Array(96).map((_, i) => (i * 5) % 256);
    const otherKeys = derive(newEntropy(), LUNA_ID);
    const { calls } = routePhrase({
      "GET /api/v1/cloud/phrase/scopes": [200, {
        scopes: [
          { scope: "scope-1", sealed_scope_secret: toBase64(sealScopeSecret(secret, oldKeys.sealPublic, LUNA_ID, "scope-1")) },
          { scope: "scope-2", sealed_scope_secret: toBase64(sealScopeSecret(secret, otherKeys.sealPublic, LUNA_ID, "scope-2")) },
        ],
      }],
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });

    await replacePhrase({ ...common, proof: { oldEntropy }, exposed: false });

    const put = calls.find((c) => c.key === "PUT /api/v1/cloud/phrase").body;
    expect(put.rescoped).toHaveLength(1);
    expect(put.rescoped[0].scope).toBe("scope-1");
    const opened = openScopeSecret(
      fromBase64(put.rescoped[0].sealed_scope_secret),
      derive(phraseToEntropy(newPhrase), LUNA_ID).sealSecret,
      LUNA_ID,
      "scope-1",
    );
    expect(opened).toEqual(secret);
  });

  it("stops with a plain message and sends nothing when a re-sealed scope does not open with the new phrase", async () => {
    const oldEntropy = newEntropy();
    const oldKeys = derive(oldEntropy, LUNA_ID);
    const secret = new Uint8Array(96).map((_, i) => (i * 3) % 256);
    const { calls } = routePhrase({
      "GET /api/v1/cloud/phrase/scopes": [200, {
        scopes: [{ scope: "scope-1", sealed_scope_secret: toBase64(sealScopeSecret(secret, oldKeys.sealPublic, LUNA_ID, "scope-1")) }],
      }],
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });
    sealHooks.corrupt = true;
    try {
      await expect(replacePhrase({ ...common, proof: { oldEntropy }, exposed: false })).rejects.toThrow(
        "Your phrase was not changed.",
      );
    } finally {
      sealHooks.corrupt = false;
    }
    expect(calls.filter((c) => c.key.startsWith("PUT"))).toHaveLength(0);
    expect(calls.filter((c) => c.key.startsWith("POST"))).toHaveLength(0);
  });

  it("signs the re-sealed scopes too: dropping or swapping one breaks the signature", async () => {
    const oldEntropy = newEntropy();
    const { authPublic, sealPublic } = derive(oldEntropy, LUNA_ID);
    const secret = new Uint8Array(96).map((_, i) => (i * 7) % 256);
    const sealedFor = (scope) => toBase64(sealScopeSecret(secret, sealPublic, LUNA_ID, scope));
    const { calls } = routePhrase({
      "GET /api/v1/cloud/phrase/scopes": [200, {
        scopes: [
          { scope: "scope-b", sealed_scope_secret: sealedFor("scope-b") },
          { scope: "scope-a", sealed_scope_secret: sealedFor("scope-a") },
        ],
      }],
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });
    await replacePhrase({ ...common, proof: { oldEntropy }, exposed: false });
    const put = calls.find((c) => c.key === "PUT /api/v1/cloud/phrase").body;
    const signature = fromBase64(put.signature);
    expect(put.rescoped).toHaveLength(2);
    expect(verify(authPublic, REPLACE_DOMAIN, replaceMessage(CHALLENGE, put), signature)).toBe(true);
    // The order the list is sent in does not matter, only its content.
    const reordered = { ...put, rescoped: [...put.rescoped].reverse() };
    expect(verify(authPublic, REPLACE_DOMAIN, replaceMessage(CHALLENGE, reordered), signature)).toBe(true);
    const dropped = { ...put, rescoped: put.rescoped.slice(0, 1) };
    expect(verify(authPublic, REPLACE_DOMAIN, replaceMessage(CHALLENGE, dropped), signature)).toBe(false);
    const swapped = {
      ...put,
      rescoped: [{ ...put.rescoped[0], sealed_scope_secret: toBase64(new Uint8Array(put.rescoped[0].sealed_scope_secret.length).fill(1)) }, put.rescoped[1]],
    };
    expect(verify(authPublic, REPLACE_DOMAIN, replaceMessage(CHALLENGE, swapped), signature)).toBe(false);
  });

  it("reads the scopes before it signs the challenge, so the challenge is still fresh", async () => {
    const { calls } = routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });
    await replacePhrase({ ...common, proof: { oldEntropy: newEntropy() }, exposed: false });
    const keys = calls.map((c) => c.key);
    expect(keys.indexOf("GET /api/v1/cloud/phrase/scopes")).toBeLessThan(keys.indexOf("POST /api/v1/cloud/phrase/challenge"));
  });

  it("stops the save when the scopes cannot be read: no PUT, so no private scope is retired by mistake", async () => {
    const { calls } = routePhrase({
      "GET /api/v1/cloud/phrase/scopes": [500, { error: "down" }],
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });
    await expect(replacePhrase({ ...common, proof: { oldEntropy: newEntropy() }, exposed: true })).rejects.toThrow(
      "Could not read your private backups. Try again.",
    );
    expect(calls.filter((c) => c.key.startsWith("PUT"))).toHaveLength(0);
  });

  it("never writes the phrase or keys to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [200, { set: true, set_at: 1 }],
    });
    await replacePhrase({ ...common, proof: { oldEntropy: newEntropy() }, exposed: false });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("a refused save is not retried: one PUT, and the error is mapped", async () => {
    const { calls } = routePhrase({
      "POST /api/v1/cloud/phrase/challenge": challengeReply,
      "PUT /api/v1/cloud/phrase": [403, { error: "no" }],
    });
    await expect(replacePhrase({ ...common, proof: { oldEntropy: newEntropy() }, exposed: false })).rejects.toBeTruthy();
    expect(calls.filter((c) => c.key.startsWith("PUT"))).toHaveLength(1);
  });
});

describe("replaceErrorMessage", () => {
  it("maps a lockout to the plain lockout line, whichever proof was sent", () => {
    expect(replaceErrorMessage({ status: 429 }, "password")).toBe(LOCKED_OUT_MESSAGE);
    expect(replaceErrorMessage({ status: 429 }, "old")).toBe(LOCKED_OUT_MESSAGE);
  });

  it("says the password was wrong for a password refusal, and to start again for an old-phrase refusal", () => {
    expect(replaceErrorMessage({ status: 403 }, "password")).toBe("That is not your Luna password. Try again.");
    expect(replaceErrorMessage({ status: 403 }, "old")).toMatch(/Start again from Change phrase/);
  });
});

describe("normalizePhraseStatus, resealing", () => {
  it("reads resealing as a boolean, false when missing", () => {
    expect(normalizePhraseStatus({ resealing: true }).resealing).toBe(true);
    expect(normalizePhraseStatus({}).resealing).toBe(false);
  });
});

describe("signed bytes match the Rust side", () => {
  // The same vectors are pinned in cloud_phrase.rs: if either side drifts, both tests fail.
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rescoped = [
    { scope: "scope-b", sealed_scope_secret: toBase64(new Uint8Array(40).fill(2)) },
    { scope: "scope-a", sealed_scope_secret: toBase64(new Uint8Array(40).fill(1)) },
  ];

  it("hashes the re-sealed scopes to the pinned bytes", () => {
    expect(hex(rescopedHash(rescoped))).toBe("57825ea6ce207824ca047b67d2b5856af1df29c15afeb41e83d1d3b4a5742f28");
    expect(hex(rescopedHash([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("builds the pinned replace message", () => {
    const message = replaceMessage(new Uint8Array(32).fill(7), {
      seal_public: toBase64(new Uint8Array(32).fill(3)),
      auth_public: toBase64(new Uint8Array(32).fill(4)),
      self_sealed: toBase64(new Uint8Array(48).fill(5)),
      exposed: true,
      rescoped,
    });
    expect(hex(message)).toBe(
      "000000096368616c6c656e67650000002007070707070707070707070707070707070707070707070707070707070707070000000b7365616c5f7075626c69630000002003030303030303030303030303030303030303030303030303030303030303030000000b617574685f7075626c69630000002004040404040404040404040404040404040404040404040404040404040404040000001073656c665f7365616c65645f6861736800000020bae0441407d7f6e0fe664fd07f8d144340acea5f88820f2ad0c800671c9479e3000000076578706f73656400000001010000000d726573636f7065645f686173680000002057825ea6ce207824ca047b67d2b5856af1df29c15afeb41e83d1d3b4a5742f28",
    );
  });
});
