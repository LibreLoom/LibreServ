import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  dataUriToBytes,
  diagramBytesFromExport,
  diagramLoadXml,
  drawioEmbedUrl,
  parseEmbedMessage,
  probeDrawioPack,
} from "./drawioApi.js";
import { BLANK_DRAWIO_XML } from "../../../lib/diagramFile.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drawioEmbedUrl", () => {
  it("points at the local pack with the JSON embed protocol", () => {
    const url = drawioEmbedUrl();
    expect(url.startsWith("/drawio/index.html?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("embed")).toBe("1");
    expect(params.get("proto")).toBe("json");
    // stealth disables draw.io's realtime sync channel — nothing leaves Luna.
    expect(params.get("stealth")).toBe("1");
    // Luna's frame owns close chrome; the editor's Exit stays hidden.
    expect(params.get("noExitBtn")).toBe("1");
    expect(params.get("saveAndExit")).toBe("0");
    expect(params.get("ui")).toBeNull();
    expect(params.get("noSaveBtn")).toBeNull();
  });

  it("follows the app theme and hides Save for read-only opens", () => {
    const dark = new URLSearchParams(drawioEmbedUrl({ dark: true }).split("?")[1]);
    expect(dark.get("ui")).toBe("dark");
    const ro = new URLSearchParams(drawioEmbedUrl({ canWrite: false }).split("?")[1]);
    expect(ro.get("noSaveBtn")).toBe("1");
  });
});

describe("parseEmbedMessage", () => {
  it("parses JSON protocol messages and ignores everything else", () => {
    expect(parseEmbedMessage('{"event":"init"}')).toEqual({ event: "init" });
    expect(parseEmbedMessage("")).toBe(null);
    expect(parseEmbedMessage("not json {")).toBe(null);
    expect(parseEmbedMessage({ event: "init" })).toBe(null);
    expect(parseEmbedMessage('"a string"')).toBe(null);
    expect(parseEmbedMessage(null)).toBe(null);
  });
});

describe("diagramLoadXml", () => {
  it("passes .drawio XML through and blanks empty files", () => {
    expect(diagramLoadXml("<mxfile/>", null, "xml")).toBe("<mxfile/>");
    expect(diagramLoadXml("   ", null, "xml")).toBe(BLANK_DRAWIO_XML);
  });

  it("wraps svg/png containers as data URIs draw.io can unpack", () => {
    const bytes = new TextEncoder().encode("<svg>fake</svg>").buffer;
    const uri = diagramLoadXml("", bytes, "svg");
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const back = dataUriToBytes(uri);
    expect(new TextDecoder().decode(back)).toBe("<svg>fake</svg>");
    const pngUri = diagramLoadXml("", bytes, "png");
    expect(pngUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("starts blank on an empty image-container file", () => {
    expect(diagramLoadXml("", new ArrayBuffer(0), "svg")).toBe(BLANK_DRAWIO_XML);
  });
});

describe("diagramBytesFromExport", () => {
  it("encodes xml containers as utf8 mxfile bytes", () => {
    const out = diagramBytesFromExport("xml", { xml: "<mxfile/>" });
    expect(new TextDecoder().decode(out)).toBe("<mxfile/>");
  });

  it("decodes svg/png containers from their export data URI", () => {
    const svg = "<svg xmlns='x'><diagram/></svg>";
    const data = `data:image/svg+xml;base64,${btoa(svg)}`;
    const out = diagramBytesFromExport("svg", { data });
    expect(new TextDecoder().decode(out)).toBe(svg);
  });

  it("rejects empty export payloads instead of writing a corrupt file", () => {
    expect(() => diagramBytesFromExport("xml", { xml: " " })).toThrow();
    expect(() => diagramBytesFromExport("svg", { data: "not-a-uri" })).toThrow();
    expect(() => diagramBytesFromExport("png", {})).toThrow();
  });
});

describe("dataUriToBytes", () => {
  it("decodes base64 and percent-encoded utf8 payloads", () => {
    const b64 = `data:text/plain;base64,${btoa("hello")}`;
    expect(new TextDecoder().decode(dataUriToBytes(b64))).toBe("hello");
    const utf8 = `data:text/plain,${encodeURIComponent("héllo")}`;
    expect(new TextDecoder().decode(dataUriToBytes(utf8))).toBe("héllo");
    expect(dataUriToBytes("garbage").length).toBe(0);
  });
});

describe("bytesToBase64", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 66]);
    const back = dataUriToBytes(`data:application/octet-stream;base64,${bytesToBase64(bytes)}`);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe("probeDrawioPack", () => {
  function stubFetch(impl) {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  it("reports present only when the marker file answers JSON", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ pack: "luna-drawio", version: "v1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await probeDrawioPack()).toBe("present");
  });

  it("reports missing when the SPA fallback answers HTML instead", async () => {
    stubFetch(async () =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(await probeDrawioPack()).toBe("missing");
  });

  it("reports missing on 404s and foreign JSON bodies", async () => {
    stubFetch(async () => new Response("{}", { status: 404 }));
    expect(await probeDrawioPack()).toBe("missing");
    stubFetch(async () =>
      new Response(JSON.stringify({ pack: "something-else" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await probeDrawioPack()).toBe("missing");
  });

  it("reports unreachable when Luna itself can't be contacted", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await probeDrawioPack()).toBe("unreachable");
  });
});
