import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import WhiteboardEditor from "./WhiteboardEditor.jsx";
import { applySceneToYDoc } from "../../../lib/whiteboardDoc.js";
import { driveSource, FileSourceProvider } from "../../../lib/fileSource.jsx";

vi.mock("@libreloom/ui/hooks/useTheme.jsx", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

// The lazy ~1MB chunk is the one thing we fake — everything between the
// fetch and the canvas (CollabDocSync, the Yjs adapter, autosave) runs for
// real.
const excalidrawState = {
  props: /** @type {any} */ (null),
  api: /** @type {any} */ (null),
  elements: /** @type {object[]} */ ([]),
  files: /** @type {Record<string, object>} */ ({}),
  throwError: false,
};

vi.mock("@excalidraw/excalidraw", async () => {
  const React = await import("react");
  excalidrawState.api = {
    updateScene: vi.fn(),
    getSceneElements: () => excalidrawState.elements,
    getAppState: () => ({}),
    getFiles: () => excalidrawState.files,
    addFiles: vi.fn(),
  };
  const Fake = (props) => {
    if (excalidrawState.throwError) {
      throw new Error("Simulated Excalidraw crash");
    }
    excalidrawState.props = props;
    React.useEffect(() => {
      props.excalidrawAPI?.(excalidrawState.api);
    }, [props]);
    return React.createElement("div", { "data-testid": "excalidraw-canvas" });
  };
  return {
    Excalidraw: Fake,
    CaptureUpdateAction: { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" },
    reconcileElements: (_local, remote) => remote,
    restore: (data) => ({
      elements: data?.elements || [],
      appState: data?.appState || {},
      files: data?.files || {},
    }),
  };
});

/** Remote applies wait for an animation frame; a solo session's local
 * edits reach the doc once the canvas has been quiet for 250ms. Long
 * enough for both. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 300));

const sockets = [];

vi.mock("../office/collabSocket.js", () => ({
  CollabSocket: class {
    static MAX_RECONNECT_ATTEMPTS = 3;

    constructor(_driveId, _path, url) {
      this.url = url;
      this.onMessage = null;
      this.onStatus = null;
      this.sent = [];
      this.presence = [];
      this.savedCalls = [];
      this._closed = false;
      this._attempts = 0;
      sockets.push(this);
    }

    connect() {
      this.onStatus?.("connecting");
    }

    close() {
      this._closed = true;
    }

    sendOp(payload) {
      this.sent.push(payload);
    }

    sendPresence(payload) {
      this.presence.push(payload);
    }

    sendSaved(size) {
      this.savedCalls.push(size);
    }
  },
}));

const RECT = {
  id: "rect-1",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  version: 1,
  versionNonce: 123,
  isDeleted: false,
};

const PROPS = {
  driveId: "d",
  path: "boards/plan.excalidraw",
  canWrite: true,
  onClose: () => {},
};

function textResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sceneFile(elements = [RECT]) {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "test",
    elements,
    appState: {},
    files: {},
  });
}

function stubLuna(fileBody = sceneFile()) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/files/content")) return textResponse(fileBody);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function lastSocket() {
  return sockets[sockets.length - 1];
}

async function welcome(socket, peers = [{ peer_id: 1, username: "Ada" }]) {
  await act(async () => {
    socket.onMessage?.({
      type: "welcome",
      peer_id: 1,
      can_write: true,
      peers,
      catchup: [],
    });
  });
}

/** @param {Uint8Array} bytes */
function toB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** @param {string} b64 */
function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

afterEach(() => {
  sockets.length = 0;
  excalidrawState.props = null;
  excalidrawState.elements = [];
  excalidrawState.files = {};
  excalidrawState.throwError = false;
  excalidrawState.api?.updateScene.mockClear();
  vi.unstubAllGlobals();
});

describe("WhiteboardEditor", () => {
  it("opens the canvas with the file's scene and joins the collab room", async () => {
    stubLuna();
    render(<WhiteboardEditor {...PROPS} />);
    expect(sockets).toHaveLength(1);
    expect(lastSocket().url).toContain("/api/v1/collab/ws");
    expect(lastSocket().url).toContain("plan.excalidraw");

    await welcome(lastSocket());
    await screen.findByTestId("excalidraw-canvas");
    expect(excalidrawState.props.initialData.elements[0].id).toBe("rect-1");
    expect(excalidrawState.props.viewModeEnabled).toBe(false);
    expect(excalidrawState.props.theme).toBe("light");
    // Luna owns the file — the editor's own save/load/file buttons stay off.
    expect(excalidrawState.props.UIOptions.canvasActions.saveToActiveFile).toBe(false);
    expect(excalidrawState.props.UIOptions.canvasActions.loadScene).toBe(false);
  });

  it("writes local edits into the shared doc and flags unsaved changes", async () => {
    stubLuna();
    const onSaveStateChange = vi.fn();
    render(<WhiteboardEditor {...PROPS} onSaveStateChange={onSaveStateChange} />);
    await welcome(lastSocket());
    await screen.findByTestId("excalidraw-canvas");

    const opsBefore = lastSocket().sent.length;
    const moved = { ...RECT, x: 55, version: 2, versionNonce: 124 };
    await act(async () => {
      // color-scan: ignore-next-line excalidraw scene fixture — hex is the wire format
      excalidrawState.props.onChange([moved], { viewBackgroundColor: "#fff" }, {});
      await nextFrame();
    });
    expect(lastSocket().sent.length).toBeGreaterThan(opsBefore);
    expect(onSaveStateChange).toHaveBeenCalledWith(true);
  });

  it("applies a remote element update through updateScene, off the undo stack", async () => {
    stubLuna();
    render(<WhiteboardEditor {...PROPS} />);
    await welcome(lastSocket());
    await screen.findByTestId("excalidraw-canvas");

    // A peer joins by syncing our seeded doc first (the s1/s2 handshake),
    // then adds an ellipse into the shared structure.
    const peer = new Y.Doc();
    const seedOp = lastSocket().sent.find((p) => p.k === "u");
    Y.applyUpdate(peer, fromB64(seedOp.d), "remote");
    peer.transact(
      () =>
        applySceneToYDoc(peer, {
          elements: [RECT, { ...RECT, id: "ell-1", type: "ellipse" }],
        }),
      "local",
    );
    const update = Y.encodeStateAsUpdate(peer);
    peer.destroy();

    await act(async () => {
      lastSocket().onMessage?.({
        type: "op",
        seq: 2,
        peer_id: 2,
        payload: { k: "u", d: toB64(update) },
      });
      await nextFrame();
    });
    const calls = excalidrawState.api.updateScene.mock.calls;
    const last = calls[calls.length - 1][0];
    expect(last.elements.map((e) => e.id)).toContain("ell-1");
    expect(last.captureUpdate).toBe("NEVER");
  });

  it("saves the canonical scene JSON through the normal upload path", async () => {
    /** @type {{ url: string, file: File | null }[]} */
    const uploads = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        const u = String(url);
        if (u.includes("/files/upload")) {
          const form = /** @type {FormData} */ (opts?.body);
          uploads.push({ url: u, file: /** @type {File | null} */ (form?.get("file")) });
        }
        if (u.includes("/files/content")) return textResponse(sceneFile());
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    let saveFn = null;
    render(
      <WhiteboardEditor
        {...PROPS}
        onRegisterSave={(fn) => {
          saveFn = fn;
        }}
      />,
    );
    await welcome(lastSocket());
    await screen.findByTestId("excalidraw-canvas");

    const moved = { ...RECT, x: 77, version: 2, versionNonce: 124 };
    await act(async () => {
      excalidrawState.props.onChange([moved], {}, {});
    });
    expect(saveFn).toBeTypeOf("function");
    await act(async () => {
      await saveFn();
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toContain("overwrite=1");
    const saved = JSON.parse(await uploads[0].file.text());
    expect(saved.type).toBe("excalidraw");
    expect(saved.version).toBe(2);
    expect(saved.elements[0].x).toBe(77);
    // The room hears about the save — peers get their "saved" beat.
    expect(lastSocket().savedCalls.length).toBeGreaterThan(0);
  });

  it("runs view-only without write ops when canWrite is false", async () => {
    stubLuna();
    render(<WhiteboardEditor {...PROPS} canWrite={false} />);
    await welcome(lastSocket());
    await screen.findByTestId("excalidraw-canvas");
    expect(excalidrawState.props.viewModeEnabled).toBe(true);

    const opsBefore = lastSocket().sent.length;
    await act(async () => {
      excalidrawState.props.onChange([{ ...RECT, x: 9, version: 2, versionNonce: 124 }], {}, {});
    });
    expect(lastSocket().sent.length).toBe(opsBefore);
  });

  it("works solo when the source has no collab channel", async () => {
    stubLuna();
    const guestSource = {
      ...driveSource,
      kind: "share",
      guest: true,
      collab: false,
      collabWsUrl: undefined,
    };
    render(
      <FileSourceProvider source={/** @type {any} */ (guestSource)}>
        <WhiteboardEditor {...PROPS} />
      </FileSourceProvider>,
    );
    // No hub, no socket — the file alone seeds the doc.
    await screen.findByTestId("excalidraw-canvas");
    expect(sockets).toHaveLength(0);
    expect(excalidrawState.props.initialData.elements[0].id).toBe("rect-1");
  });

  it("shows the issue card when the file cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    render(<WhiteboardEditor {...PROPS} />);
    await screen.findByText(/couldn't open this whiteboard/i);
    expect(screen.queryByTestId("excalidraw-canvas")).toBeNull();
  });

  it("shows 'This file doesn't exist anymore.' when the file is not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    render(<WhiteboardEditor {...PROPS} />);
    await screen.findByText("This file doesn't exist anymore.");
    expect(screen.getByText(/couldn't open this whiteboard/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reopen/i })).toBeNull();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("survives StrictMode double-mount and continues syncing edits", async () => {
    stubLuna();
    const onSaveStateChange = vi.fn();
    render(
      <React.StrictMode>
        <WhiteboardEditor {...PROPS} onSaveStateChange={onSaveStateChange} />
      </React.StrictMode>,
    );
    // StrictMode unmounts the first socket and reconnects a second live socket
    expect(sockets.length).toBe(2);
    expect(sockets[0]._closed).toBe(true);
    expect(lastSocket()._closed).toBe(false);

    await welcome(lastSocket());
    await screen.findByTestId("excalidraw-canvas");

    const opsBefore = lastSocket().sent.length;
    const moved = { ...RECT, x: 55, version: 2, versionNonce: 124 };
    await act(async () => {
      // color-scan: ignore-next-line excalidraw scene fixture — hex is the wire format
      excalidrawState.props.onChange([moved], { viewBackgroundColor: "#fff" }, {});
      await nextFrame();
    });
    expect(lastSocket().sent.length).toBeGreaterThan(opsBefore);
    expect(onSaveStateChange).toHaveBeenCalledWith(true);
  });

  it("catches canvas render crash with error boundary and shows issue card", async () => {
    stubLuna();
    excalidrawState.throwError = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<WhiteboardEditor {...PROPS} />);
    await welcome(lastSocket());
    await screen.findByText(/couldn't display this whiteboard/i);
    expect(screen.getByText(/whiteboard view crashed/i)).toBeInTheDocument();
    spy.mockRestore();
  });

  it("does not call updateScene when collaborators are unchanged", async () => {
    stubLuna();
    render(<WhiteboardEditor {...PROPS} />);
    await welcome(lastSocket());
    await screen.findByTestId("excalidraw-canvas");

    // Wait for initial microtask to settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const callsBefore = excalidrawState.api.updateScene.mock.calls.length;

    // A change to purely local awareness or non-peer change should not re-trigger updateScene
    await act(async () => {
      excalidrawState.props.onChange([RECT], { selectedElementIds: {} }, {});
    });

    expect(excalidrawState.api.updateScene.mock.calls.length).toBe(callsBefore);
  });
});
