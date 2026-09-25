import { describe, expect, it, vi } from "vitest";
import { driveSource, shareSource } from "./fileSource.jsx";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("shareSource", () => {
  it("builds link-scoped content and download URLs", () => {
    const source = shareSource({ token: "abc", kind: "folder" });
    expect(source.contentHref("x", "a/b.txt")).toBe("/s/abc/file?path=a%2Fb.txt");
    expect(source.downloadHref("x", "a/b.txt")).toBe(
      "/s/abc/file?path=a%2Fb.txt&download=1",
    );
    expect(source.downloadHref("x", "a/dir", "dir")).toBe("/s/abc/zip?path=a%2Fdir");
  });

  it("drops the path for file links — the link is the file", () => {
    const source = shareSource({ token: "abc", kind: "file", fileName: "r.pdf" });
    expect(source.contentHref("x", "anything/at/all")).toBe("/s/abc/file");
    expect(source.downloadHref("x", "")).toBe("/s/abc/file?download=1");
  });

  it("sends the link password as a header, never in the URL", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      calls.push([url, opts]);
      return json({ entries: [] });
    }));
    const source = shareSource({ token: "abc", password: "secret", kind: "folder", caps: "view" });
    await source.listDir("x", "sub");
    const [url, opts] = calls[0];
    expect(String(url)).toBe("/s/abc/list?path=sub");
    expect(opts.headers["X-Share-Password"]).toBe("secret");
    expect(String(url)).not.toContain("password");
    vi.unstubAllGlobals();
  });

  it("maps list responses to plain entry arrays", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ entries: [{ name: "a.txt", kind: "file" }] })));
    const source = shareSource({ token: "abc", kind: "folder", caps: "view" });
    expect(await source.listDir("x", "")).toEqual([{ name: "a.txt", kind: "file" }]);
    vi.unstubAllGlobals();
  });

  it("view-blind links never fetch a listing — drop boxes return empty", async () => {
    const fetchMock = vi.fn(async () => json({ entries: [{ name: "x" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const source = shareSource({ token: "abc", kind: "dropbox", caps: "upload" });
    expect(await source.listDir("x", "")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("marks guests as non-collab so editors stay off the hub", () => {
    const source = shareSource({ token: "abc", kind: "folder" });
    expect(source.guest).toBe(true);
    expect(source.collab).toBe(false);
  });

  it("reads form responses through the link-scoped route with the password header", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      calls.push([url, opts]);
      return json({ responses: [{ id: "r1", answers: {} }] });
    }));
    const source = shareSource({ token: "abc", password: "pw", kind: "folder", caps: "view" });
    expect(await source.formResponses("ignored", "docs/rsvp.lunaform"))
      .toEqual([{ id: "r1", answers: {} }]);
    const [url, opts] = calls[0];
    expect(String(url)).toBe("/s/abc/responses?path=docs%2Frsvp.lunaform");
    expect(opts.headers["X-Share-Password"]).toBe("pw");
    vi.unstubAllGlobals();
  });

  it("drops the responses path for file links — the link is the form", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(url);
      return json({ responses: [] });
    }));
    const source = shareSource({ token: "abc", kind: "file", fileName: "rsvp.lunaform", caps: "view" });
    expect(await source.formResponses("ignored", "rsvp.lunaform")).toEqual([]);
    expect(String(calls[0])).toBe("/s/abc/responses");
    vi.unstubAllGlobals();
  });
});

describe("driveSource", () => {
  it("reads form responses through the member route", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(url);
      return json({ responses: [{ id: "r1" }] });
    }));
    expect(await driveSource.formResponses("d1", "a/b.lunaform")).toEqual([{ id: "r1" }]);
    expect(String(calls[0])).toBe(
      "/api/v1/forms/responses?drive_id=d1&path=a%2Fb.lunaform",
    );
    vi.unstubAllGlobals();
  });
});
