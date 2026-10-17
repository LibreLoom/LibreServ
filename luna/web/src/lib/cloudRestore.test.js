import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entropyToPhrase } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { NO_BACKUPS, SIGNING_MISMATCH } from "@libreloom/ui/lib/cloud/cloudKeys.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import fixture from "../../../crates/lunad/src/backup/cloud/fixture.json";
import { getJson, postJson } from "./api";
import { savePhrase, toBase64 } from "./cloudPhrase";
import { getRestoreStatus, restoreFromPhrase, RESTORE_PATH } from "./cloudRestore";

vi.mock("./api", () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock("./cloudPhrase", async (importOriginal) => ({
  ...(await importOriginal()),
  savePhrase: vi.fn(),
}));

const getJsonMock = vi.mocked(getJson);
const postJsonMock = vi.mocked(postJson);
const savePhraseMock = vi.mocked(savePhrase);

const hex = (value) => toBase64(hexToBytes(value));

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
  postJsonMock.mockResolvedValue({ snapshots: 1, already_indexed: 0, skipped: 0 });
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

    expect(postJsonMock).toHaveBeenCalledTimes(1);
    const [path, body] = postJsonMock.mock.calls[0];
    expect(path).toBe(RESTORE_PATH);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].key).toBe(hex(fixture.backup_key));
    expect(body.keys[0].protection_id).toBe(fixture.protection_id);
    expect(body.keys[0].version).toBe(fixture.key_version);
    expect(body.old_user_ids).toEqual(["alice"]);
    expect(result).toEqual({ snapshots: 1, alreadyIndexed: 0, skipped: 0 });
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
    const wrongKey = toBase64(new Uint8Array(32).fill(1));

    await expect(restoreFromPhrase(phrase, { ...CTX, signingPublic: wrongKey })).rejects.toThrow(SIGNING_MISMATCH);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects a phrase that opens no backups and sends nothing", async () => {
    const phrase = entropyToPhrase(new Uint8Array(16).fill(9));

    await expect(restoreFromPhrase(phrase, CTX)).rejects.toThrow(NO_BACKUPS);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
