import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSource, getShareInfo, listLunas, shareSource } from "./cloudSource.js";

const RECORDS_FAILED = "Could not load your cloud backups. Check your connection, then try again.";
const PACK_FAILED = "Could not download part of this backup. Check your connection, then try again.";

/** A JSON reply shaped like the fetch Response the code reads. */
function jsonReply(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  };
}

/** A binary reply shaped like the fetch Response the code reads. */
function packReply(bytes) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer,
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listLunas", () => {
  it("returns the lunas array from GET /api/v1/cloud/lunas", async () => {
    globalThis.fetch.mockResolvedValue(jsonReply({ lunas: [{ luna_id: "L1", name: "Home", linked: true }] }));
    const lunas = await listLunas();
    expect(lunas).toEqual([{ luna_id: "L1", name: "Home", linked: true }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/v1/cloud/lunas",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("accountSource", () => {
  it("lists records from the Luna's record route and decodes base64", async () => {
    globalThis.fetch.mockResolvedValue(jsonReply({ records: [{ name: "a", data: "AQL/" }] }));
    const source = accountSource("L1");
    expect(source.lunaId).toBe("L1");
    const records = await source.listRecords("self");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/v1/cloud/lunas/L1/records/self",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(records).toEqual([{ name: "a", data: new Uint8Array([1, 2, 255]) }]);
  });

  it("fetches a pack as bytes", async () => {
    globalThis.fetch.mockResolvedValue(packReply(new Uint8Array([9, 8, 7])));
    const bytes = await accountSource("L1").getPack("abc");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/v1/cloud/lunas/L1/packs/abc",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("throws the server's sentence and keeps the status on a 404", async () => {
    globalThis.fetch.mockResolvedValue(jsonReply({ error: "x" }, 404));
    const err = await accountSource("L1").listRecords("self").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("x");
    expect(err.status).toBe(404);
  });

  it("falls back to the records sentence when the server gives none", async () => {
    globalThis.fetch.mockResolvedValue(jsonReply({}, 500));
    await expect(accountSource("L1").listRecords("self")).rejects.toThrow(RECORDS_FAILED);
  });

  it("falls back to the pack sentence when a pack fails", async () => {
    globalThis.fetch.mockResolvedValue(jsonReply({}, 404));
    const err = await accountSource("L1").getPack("abc").catch((e) => e);
    expect(err.message).toBe(PACK_FAILED);
    expect(err.status).toBe(404);
  });
});

describe("getShareInfo", () => {
  it("sends the token in X-Share-Token and returns the share details", async () => {
    const info = {
      luna_id: "L1",
      luna_name: "Home",
      sent_by: "Alice",
      scope: { kind: "folder", value: "Photos" },
      expires_at: 1700000000,
    };
    globalThis.fetch.mockResolvedValue(jsonReply(info));
    expect(await getShareInfo("tok")).toEqual(info);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("/api/v1/share");
    expect(opts.credentials).toBe("include");
    expect(opts.headers["X-Share-Token"]).toBe("tok");
  });
});

describe("shareSource", () => {
  it("reads records and packs through the share routes with the token header", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonReply({ records: [{ name: "a", data: "AQL/" }] }));
    globalThis.fetch.mockResolvedValueOnce(packReply(new Uint8Array([5])));
    const source = shareSource("tok", "L1");
    expect(source.lunaId).toBe("L1");

    const records = await source.listRecords("snapshots");
    expect(records).toEqual([{ name: "a", data: new Uint8Array([1, 2, 255]) }]);
    const [recordUrl, recordOpts] = globalThis.fetch.mock.calls[0];
    expect(recordUrl).toBe("/api/v1/share/records/snapshots");
    expect(recordOpts.credentials).toBe("include");
    expect(recordOpts.headers).toEqual({ "X-Share-Token": "tok" });

    const pack = await source.getPack("abc");
    expect(pack).toEqual(new Uint8Array([5]));
    const [packUrl, packOpts] = globalThis.fetch.mock.calls[1];
    expect(packUrl).toBe("/api/v1/share/packs/abc");
    expect(packOpts.headers).toEqual({ "X-Share-Token": "tok" });
  });
});

describe("private session routes", () => {
  it("posts to the account challenge and open routes and returns the token", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonReply({ challenge: "ab12", expires_at: 1700000000 }));
    globalThis.fetch.mockResolvedValueOnce(jsonReply({ token: "tok2", expires_at: 1700001800 }));
    const source = accountSource("L1");

    expect(await source.privateChallenge()).toBe("ab12");
    const [challengeUrl, challengeOpts] = globalThis.fetch.mock.calls[0];
    expect(challengeUrl).toBe("/api/v1/cloud/lunas/L1/private/challenge");
    expect(challengeOpts.method).toBe("POST");
    expect(challengeOpts.credentials).toBe("include");

    const opened = await source.privateOpen({ scope: "s1", challenge: "ab12", signature: "cd34" });
    expect(opened).toEqual({ token: "tok2", expiresAt: 1700001800 });
    const [openUrl, openOpts] = globalThis.fetch.mock.calls[1];
    expect(openUrl).toBe("/api/v1/cloud/lunas/L1/private/open");
    expect(openOpts.method).toBe("POST");
    expect(JSON.parse(openOpts.body)).toEqual({ scope: "s1", challenge: "ab12", signature: "cd34" });
  });

  it("posts to the share challenge and open routes with the share token", async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonReply({ challenge: "ef56", expires_at: 1 }));
    globalThis.fetch.mockResolvedValueOnce(jsonReply({ token: "tok3", expires_at: 2 }));
    const source = shareSource("share-tok", "L1");

    expect(await source.privateChallenge()).toBe("ef56");
    expect(globalThis.fetch.mock.calls[0][0]).toBe("/api/v1/share/private/challenge");
    expect(globalThis.fetch.mock.calls[0][1].headers).toEqual({ "X-Share-Token": "share-tok" });

    await source.privateOpen({ scope: "s2", challenge: "ef56", signature: "99" });
    const [openUrl, openOpts] = globalThis.fetch.mock.calls[1];
    expect(openUrl).toBe("/api/v1/share/private/open");
    expect(openOpts.headers).toEqual({ "X-Share-Token": "share-tok", "Content-Type": "application/json" });
    expect(JSON.parse(openOpts.body)).toEqual({ scope: "s2", challenge: "ef56", signature: "99" });
  });

  it("keeps the server sentence on a 403 and uses the private fallback otherwise", async () => {
    globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "Not allowed." }) });
    const denied = await accountSource("L1").privateChallenge().catch((e) => e);
    expect(denied.message).toBe("Not allowed.");
    expect(denied.status).toBe(403);

    globalThis.fetch.mockResolvedValueOnce(jsonReply({}, 500));
    const broken = await accountSource("L1").privateChallenge().catch((e) => e);
    expect(broken.message).toBe("Could not open your private items. Check your connection, then try again.");
  });
});

describe("withPrivateToken", () => {
  it("returns the same source and adds X-Private-Token to its reads", async () => {
    globalThis.fetch.mockResolvedValue(jsonReply({ records: [] }));
    const base = accountSource("L1");
    const scoped = base.withPrivateToken("ptok");
    expect(scoped.lunaId).toBe("L1");

    await scoped.listRecords("psnapshots");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("/api/v1/cloud/lunas/L1/records/psnapshots");
    expect(opts.headers).toEqual({ "X-Private-Token": "ptok" });
  });

  it("keeps the share token alongside the private token", async () => {
    globalThis.fetch.mockResolvedValue(packReply(new Uint8Array([7])));
    const scoped = shareSource("share-tok", "L1").withPrivateToken("ptok");
    await scoped.getPack("abc");
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("/api/v1/share/packs/abc");
    expect(opts.headers).toEqual({ "X-Share-Token": "share-tok", "X-Private-Token": "ptok" });
  });
});
