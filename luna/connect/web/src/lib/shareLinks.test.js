import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShareLink, listShareLinks, revokeShareLink, shareUrl, tokenFromHash } from "./shareLinks.js";

const TOKEN = "a".repeat(43);

function jsonReply(body, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tokenFromHash", () => {
  it("accepts a 43-character token", () => {
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
  });

  it("rejects short, long, and empty hashes", () => {
    expect(tokenFromHash("#short")).toBe("");
    expect(tokenFromHash(`#${"a".repeat(44)}`)).toBe("");
    expect(tokenFromHash("#")).toBe("");
    expect(tokenFromHash("")).toBe("");
  });
});

describe("shareUrl", () => {
  it("puts the token after the hash", () => {
    expect(shareUrl("t", "https://x")).toBe("https://x/share#t");
  });
});

describe("share link requests", () => {
  it("creates a link with a POST and the scope fields", async () => {
    fetch.mockResolvedValue(jsonReply({ id: "s1", token: TOKEN, expires_at: 1 }));
    const res = await createShareLink("l1", { kind: "user", value: "abc" });
    expect(res.token).toBe(TOKEN);
    const [path, opts] = fetch.mock.calls[0];
    expect(path).toBe("/api/v1/cloud/share-links");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ luna_id: "l1", scope_kind: "user", scope_value: "abc" });
  });

  it("lists links and returns the links array", async () => {
    fetch.mockResolvedValue(jsonReply({ links: [{ id: "s1" }] }));
    expect(await listShareLinks()).toEqual([{ id: "s1" }]);
    const [path, opts] = fetch.mock.calls[0];
    expect(path).toBe("/api/v1/cloud/share-links");
    expect(opts.method ?? "GET").toBe("GET");
  });

  it("revokes by id with a DELETE", async () => {
    fetch.mockResolvedValue(jsonReply({}));
    await revokeShareLink("s1");
    const [path, opts] = fetch.mock.calls[0];
    expect(path).toBe("/api/v1/cloud/share-links/s1");
    expect(opts.method).toBe("DELETE");
  });
});
