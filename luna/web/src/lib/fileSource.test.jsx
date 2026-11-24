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
    expect(opts.headers["X-Share-Password-Utf8"]).toBe(btoa("secret"));
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

  it("lets guests into the same presence rooms as members", () => {
    const source = shareSource({ token: "abc", kind: "folder" });
    expect(source.guest).toBe(true);
    expect(source.collab).toBe(true);
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
    expect(opts.headers["X-Share-Password-Utf8"]).toBe(btoa("pw"));
    vi.unstubAllGlobals();
  });

  it("pages and summarizes form answers for a guest", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("/s/abc/summary")) {
        return json({ total: 4, questions: [{ id: "q1", answered: 4, values: [] }] });
      }
      return json({ responses: [{ id: "r3" }], total: 4, next_offset: 3 });
    }));
    const source = shareSource({ token: "abc", kind: "folder", caps: "full" });
    const page = await source.formAnswers("ignored", "docs/rsvp.lunaform", { offset: 2, limit: 1 });
    expect(page.total).toBe(4);
    expect(page.next_offset).toBe(3);
    expect(calls[0]).toBe("/s/abc/responses?path=docs%2Frsvp.lunaform&offset=2&limit=1");
    const summary = await source.formSummary("ignored", "docs/rsvp.lunaform");
    expect(summary.questions[0].answered).toBe(4);
    expect(calls[1]).toBe("/s/abc/summary?path=docs%2Frsvp.lunaform");
    // The manager link exports from the server too, never in browser memory.
    expect(source.formExportUrl("ignored", "docs/rsvp.lunaform")).toBe(
      "/s/abc/export?path=docs%2Frsvp.lunaform&format=csv",
    );
    // A file link drops the path: the link is the form.
    const fileLink = shareSource({ token: "xyz", kind: "file", fileName: "rsvp.lunaform", caps: "full" });
    expect(fileLink.formExportUrl("ignored", "rsvp.lunaform")).toBe("/s/xyz/export?format=csv");
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

  it("asks for one page of answers and keeps the server's totals", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      return json({
        responses: [{ id: "r101" }],
        total: 250,
        next_offset: 101,
        notice: "",
        revision: 9,
      });
    }));
    const page = await driveSource.formAnswers("d1", "a/b.lunaform", { offset: 100, limit: 1 });
    expect(page.responses).toEqual([{ id: "r101" }]);
    expect(page.total).toBe(250);
    expect(page.next_offset).toBe(101);
    expect(page.revision).toBe(9);
    expect(calls[0]).toBe(
      "/api/v1/forms/responses?drive_id=d1&path=a%2Fb.lunaform&offset=100&limit=1",
    );
    vi.unstubAllGlobals();
  });

  it("falls back to the page length when an older Luna sends no total", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ responses: [{ id: "r1" }, { id: "r2" }] })));
    const page = await driveSource.formAnswers("d1", "a/b.lunaform", { offset: 0, limit: 100 });
    expect(page.total).toBe(2);
    expect(page.next_offset).toBeNull();
    vi.unstubAllGlobals();
  });

  it("reads form summaries from the member route", async () => {
    const calls = /** @type {any[]} */ ([]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      calls.push(String(url));
      return json({
        total: 42,
        questions: [
          { id: "q1", answered: 40, values: [{ value: "Yes", count: 31 }, { value: "No", count: 9 }] },
          { id: "q2", answered: 42 },
        ],
      });
    }));
    const summary = await driveSource.formSummary("d1", "a/b.lunaform");
    expect(summary.total).toBe(42);
    expect(summary.questions[0].values).toEqual([
      { value: "Yes", count: 31 },
      { value: "No", count: 9 },
    ]);
    expect(summary.questions[1].values).toEqual([]);
    expect(calls[0]).toBe(
      "/api/v1/forms/summary?drive_id=d1&path=a%2Fb.lunaform",
    );
    vi.unstubAllGlobals();
  });

  it("points CSV export at the server route", () => {
    expect(driveSource.formExportUrl("d1", "a/b.lunaform")).toBe(
      "/api/v1/forms/export?drive_id=d1&path=a%2Fb.lunaform&format=csv",
    );
  });

  it("fetches text content for a file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hello world")));
    expect(await driveSource.fetchText("d1", "notes/doc.txt")).toBe("hello world");
    vi.unstubAllGlobals();
  });

  it("throws 'This file doesn't exist anymore.' when fetching text for a 404 file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Luna can't find that file or folder.", code: "not_found" }, 404)));
    await expect(driveSource.fetchText("d1", "notes/missing.txt")).rejects.toThrow("This file doesn't exist anymore.");
    vi.unstubAllGlobals();
  });

  it("throws 'This file doesn't exist anymore.' when fetching bytes for a 404 file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    await expect(driveSource.fetchBytes("d1", "notes/missing.txt")).rejects.toThrow("This file doesn't exist anymore.");
    vi.unstubAllGlobals();
  });
});
