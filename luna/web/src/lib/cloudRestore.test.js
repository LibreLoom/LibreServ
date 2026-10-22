import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derive, entropyToPhrase, SIG_PUBLIC_LEN, sign } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { NO_BACKUPS, SIGNING_MISMATCH } from "@libreloom/ui/lib/cloud/cloudKeys.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import fixture from "../../../crates/lunad/src/backup/cloud/fixture.json";
import { apiFetch, getJson, postJson } from "./api";
import { savePhrase, toBase64 } from "./cloudPhrase";
import { getRestoreStatus, restoreFromPhrase, RESTORE_PATH } from "./cloudRestore";

vi.mock("./api", () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock("./cloudPhrase", async (importOriginal) => ({
  ...(await importOriginal()),
  savePhrase: vi.fn(),
}));

const getJsonMock = vi.mocked(getJson);
const postJsonMock = vi.mocked(postJson);
const apiFetchMock = vi.mocked(apiFetch);
const savePhraseMock = vi.mocked(savePhrase);
let postedRestoreBody = null;

const hex = (value) => toBase64(hexToBytes(value));

const CHALLENGE = new Uint8Array(32).fill(5);

/** Answer the challenge request. */
function servePosts() {
  postJsonMock.mockImplementation(async (path) => {
    if (path.endsWith("/challenge")) return { challenge: toBase64(CHALLENGE) };
    return {};
  });
  apiFetchMock.mockImplementation(async (_path, options) => {
    postedRestoreBody = JSON.parse(options.body);
    const events = [
      { type: "progress", processed: 1, total: 1, snapshots: 1, already_indexed: 0, skipped: 0 },
      { type: "done", snapshots: 1, already_indexed: 0, skipped: 0 },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(events, { headers: { "Content-Type": "text/event-stream" } });
  });
}

/** The body sent to POST /api/v1/cloud/restore. */
function restoreBody() {
  return postedRestoreBody;
}

/** Serve the Rust fixture's record lists the way lunad's GET endpoints do. */
function serveFixtureRecords() {
  getJsonMock.mockImplementation(async (path) => {
    const kind = path.split("/").pop();
    return {
      records: fixture.records[kind].map((r) => ({ name: r.name, data: hex(r.data) })),
    };
  });
}

const CTX = {
  lunaId: fixture.luna_id,
  signingPublic: hex(fixture.signing_public),
  userId: "7",
  phraseSet: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  postedRestoreBody = null;
  servePosts();
  savePhraseMock.mockResolvedValue({});
  serveFixtureRecords();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getRestoreStatus", () => {
  it("reads the restore status from lunad", async () => {
    getJsonMock.mockResolvedValueOnce({ needed: true });
    await expect(getRestoreStatus()).resolves.toEqual({ needed: true });
    expect(getJsonMock).toHaveBeenCalledWith(RESTORE_PATH);
  });
});

describe("restoreFromPhrase", () => {
  it("posts the opened key and the old user ids", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));

    const result = await restoreFromPhrase(phrase, CTX);

    const body = restoreBody();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].key).toBe(hex(fixture.backup_key));
    expect(body.keys[0].protection_id).toBe(fixture.protection_id);
    expect(body.keys[0].version).toBe(fixture.key_version);
    expect(body.old_user_ids).toEqual(["alice"]);
    expect(result).toEqual({ snapshots: 1, alreadyIndexed: 0, skipped: 0 });
  });

  it("fetches a challenge and sends its signature with the restore", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));

    await restoreFromPhrase(phrase, CTX);

    const challengeCall = postJsonMock.mock.calls.find(([path]) => path.endsWith("/challenge"));
    expect(challengeCall).toBeDefined();
    const { authSecret } = derive(hexToBytes(fixture.alice_entropy), CTX.lunaId);
    const expected = toBase64(sign(authSecret, "phrase-check", CHALLENGE));
    expect(restoreBody().signature).toBe(expected);
  });

  it("reports streamed progress and rejects a provider failure after partial progress", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const onProgress = vi.fn();
    apiFetchMock.mockResolvedValueOnce(new Response(
      'data: {"type":"progress","processed":2,"total":8,"snapshots":1,"already_indexed":1,"skipped":0}\n\n' +
      'data: {"type":"error","message":"Connect stopped responding. Try again."}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    await expect(restoreFromPhrase(phrase, CTX, onProgress)).rejects.toThrow("Connect stopped responding. Try again.");
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ processed: 2, total: 8 }));
  });

  it("still restores without a signature when the challenge fails", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    postJsonMock.mockImplementation(async (path) => {
      if (path.endsWith("/challenge")) throw new Error("network");
      return { snapshots: 1, already_indexed: 0, skipped: 0 };
    });

    const result = await restoreFromPhrase(phrase, CTX);

    expect(restoreBody().signature).toBe("");
    expect(result.snapshots).toBe(1);
  });

  it("saves the phrase to this account only when none is linked yet", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));

    await restoreFromPhrase(phrase, { ...CTX, phraseSet: false });
    expect(savePhraseMock).toHaveBeenCalledTimes(1);

    savePhraseMock.mockClear();
    await restoreFromPhrase(phrase, { ...CTX, phraseSet: true });
    expect(savePhraseMock).not.toHaveBeenCalled();
  });

  it("explains when saving the phrase fails after the backups came back", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    savePhraseMock.mockRejectedValueOnce(new Error("network"));

    await expect(restoreFromPhrase(phrase, { ...CTX, phraseSet: false })).rejects.toThrow(
      "Your backups are back, but saving your recovery phrase to this account failed.",
    );
  });

  it("rejects a signing key mismatch and sends nothing", async () => {
    const phrase = entropyToPhrase(hexToBytes(fixture.alice_entropy));
    const wrongKey = toBase64(new Uint8Array(SIG_PUBLIC_LEN).fill(1));

    await expect(restoreFromPhrase(phrase, { ...CTX, signingPublic: wrongKey })).rejects.toThrow(SIGNING_MISMATCH);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects a phrase that opens no backups and sends nothing", async () => {
    const phrase = entropyToPhrase(new Uint8Array(16).fill(9));

    await expect(restoreFromPhrase(phrase, CTX)).rejects.toThrow(NO_BACKUPS);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
