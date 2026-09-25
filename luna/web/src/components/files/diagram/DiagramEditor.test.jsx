import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import DiagramEditor from "./DiagramEditor.jsx";

vi.mock("@libreloom/ui/hooks/useTheme.jsx", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

const sockets = [];

vi.mock("../office/collabSocket.js", () => ({
  CollabSocket: class {
    constructor(_driveId, _path, url) {
      this.url = url;
      this.onMessage = null;
      this.onStatus = null;
      this.sent = [];
      sockets.push(this);
    }

    connect() {}

    close() {}

    sendOp(payload) {
      this.sent.push(payload);
    }

    sendSaved() {}

    sendSaveLock() {
      return false;
    }

    sendSaveEnd() {
      return false;
    }
  },
}));

const PROPS = {
  driveId: "d",
  path: "docs/plan.drawio",
  canWrite: true,
  onClose: () => {},
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function stubLuna() {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/drawio/pack.json")) {
        return jsonResponse(200, { pack: "luna-drawio", version: "v1" });
      }
      if (u.includes("/files/content")) {
        return textResponse("<mxfile/>");
      }
      return jsonResponse(200, {});
    }),
  );
}

function lastSocket() {
  return sockets[sockets.length - 1];
}

afterEach(() => {
  sockets.length = 0;
  vi.unstubAllGlobals();
});

describe("DiagramEditor collaboration", () => {
  it("opens the editor and joins the collab room instead of locking the file", async () => {
    stubLuna();
    const onPresenceChange = vi.fn();
    render(<DiagramEditor {...PROPS} onPresenceChange={onPresenceChange} />);

    const iframe = await screen.findByTitle(/Diagram editor/);
    expect(iframe.getAttribute("src")).not.toContain("noSaveBtn");
    expect(iframe.getAttribute("src")).toContain("stealth=1");
    expect(sockets).toHaveLength(1);
    expect(lastSocket().url).toContain("/api/v1/collab/ws");
    expect(lastSocket().url).toContain("plan.drawio");
    expect(screen.queryByText(/is editing this diagram/)).toBeNull();

    await act(async () => {
      lastSocket().onMessage?.({
        type: "welcome",
        peer_id: 1,
        can_write: true,
        peers: [
          { peer_id: 1, username: "Ada" },
          { peer_id: 2, username: "Sam" },
        ],
        catchup: [],
      });
    });
    expect(onPresenceChange).toHaveBeenCalledWith("Live · Sam");
  });

  it("view-only sessions still join, and say they cannot edit", async () => {
    stubLuna();
    const onPresenceChange = vi.fn();
    render(
      <DiagramEditor {...PROPS} canWrite={false} onPresenceChange={onPresenceChange} />,
    );

    const iframe = await screen.findByTitle(/Diagram editor/);
    expect(iframe.getAttribute("src")).toContain("noSaveBtn=1");
    expect(sockets).toHaveLength(1);

    await act(async () => {
      lastSocket().onMessage?.({
        type: "welcome",
        peer_id: 4,
        can_write: false,
        peers: [{ peer_id: 4, username: "Ada" }],
        catchup: [],
      });
    });
    expect(onPresenceChange).toHaveBeenCalledWith("Live · only you · view only");
  });

  it("sends a draw.io diff patch to the room when the editor reports a change", async () => {
    stubLuna();
    render(<DiagramEditor {...PROPS} />);
    const iframe = await screen.findByTitle(/Diagram editor/);
    await act(async () => {
      lastSocket().onMessage?.({
        type: "welcome",
        peer_id: 1,
        can_write: true,
        peers: [{ peer_id: 1, username: "Ada" }],
        catchup: [],
      });
    });

    const patch = { u: { page: { cells: { i: [{ id: "n1" }] } } } };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "autosave", patch, checksum: "abc" }),
        }),
      );
    });
    expect(lastSocket().sent).toContainEqual({
      kind: "patch",
      patch,
      checksum: "abc",
    });
  });

  it("retries a rejected remote patch, and replays it after giving up", async () => {
    stubLuna();
    render(<DiagramEditor {...PROPS} />);
    const iframe = await screen.findByTitle(/Diagram editor/);
    /** @type {object[]} */
    const posted = [];
    iframe.contentWindow.postMessage = (data) => {
      posted.push(JSON.parse(String(data)));
    };

    await act(async () => {
      lastSocket().onMessage?.({
        type: "welcome",
        peer_id: 1,
        can_write: true,
        peers: [{ peer_id: 1, username: "Ada" }],
        catchup: [
          { type: "op", seq: 3, peer_id: 2, payload: { kind: "patch", patch: { n: 1 } } },
        ],
      });
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "init" }),
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "load" }),
        }),
      );
    });

    const patchPosts = () => posted.filter((msg) => msg.action === "patch");
    expect(patchPosts()).toHaveLength(1);

    const reject = () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "patch", error: "no" }),
        }),
      );
    };
    await act(async () => reject());
    await act(async () => reject());
    expect(patchPosts()).toHaveLength(3);
    await act(async () => reject());
    expect(patchPosts()).toHaveLength(3);

    await act(async () => {
      lastSocket().onMessage?.({
        type: "op",
        seq: 3,
        peer_id: 2,
        payload: { kind: "patch", patch: { n: 1 } },
      });
    });
    expect(patchPosts()).toHaveLength(4);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "patch" }),
        }),
      );
    });
    await act(async () => {
      lastSocket().onMessage?.({
        type: "op",
        seq: 3,
        peer_id: 2,
        payload: { kind: "patch", patch: { n: 1 } },
      });
    });
    expect(patchPosts()).toHaveLength(4);
  });

  it("uploads the sequence from before the export, not a patch that arrives during it", async () => {
    /** @type {string[]} */
    const uploads = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/files/upload")) uploads.push(u);
        if (u.includes("/drawio/pack.json")) {
          return jsonResponse(200, { pack: "luna-drawio", version: "v1" });
        }
        if (u.includes("/files/content")) return textResponse("<mxfile/>");
        return jsonResponse(200, {});
      }),
    );
    render(<DiagramEditor {...PROPS} />);
    const iframe = await screen.findByTitle(/Diagram editor/);
    /** @type {object[]} */
    const posted = [];
    iframe.contentWindow.postMessage = (data) => {
      posted.push(JSON.parse(String(data)));
    };

    await act(async () => {
      lastSocket().onMessage?.({
        type: "welcome",
        peer_id: 1,
        can_write: true,
        peers: [{ peer_id: 1, username: "Ada" }],
        catchup: [
          { type: "op", seq: 2, peer_id: 2, payload: { kind: "patch", patch: { n: 1 } } },
        ],
      });
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "init" }),
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "load" }),
        }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "patch" }),
        }),
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "save" }),
        }),
      );
    });
    expect(posted.some((msg) => msg.action === "export")).toBe(true);

    await act(async () => {
      lastSocket().onMessage?.({
        type: "op",
        seq: 3,
        peer_id: 2,
        payload: { kind: "patch", patch: { n: 2 } },
      });
    });
    expect(posted.filter((msg) => msg.action === "patch")).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: iframe.contentWindow,
          data: JSON.stringify({ event: "export", xml: "<mxfile/>" }),
        }),
      );
    });
    expect(uploads.some((url) => url.includes("coverage=2"))).toBe(true);
    expect(uploads.some((url) => url.includes("coverage=3"))).toBe(false);
  });
});
