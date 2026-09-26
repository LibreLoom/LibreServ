import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CollabDocSync } from "../components/files/collabDocSync.js";
import { BLANK_EXCALIDRAW_JSON } from "./whiteboardFile.js";
import {
  applySceneToYDoc,
  parseSceneText,
  persistedAppState,
  readScene,
  seedWhiteboard,
  serializeScene,
  syncSceneCache,
  whiteboardCollabAdapter,
  whiteboardIsEmpty,
  whiteboardSnapshot,
} from "./whiteboardDoc.js";

// Scene fixtures — viewBackgroundColor is a real hex string on the wire.
const CANVAS_BG = "#fafafa"; // color-scan: ignore-line excalidraw fixture
const CANVAS_DARK = "#000000"; // color-scan: ignore-line excalidraw fixture
const CANVAS_LIGHT = "#ffffff"; // color-scan: ignore-line excalidraw fixture

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

const ELLIPSE = {
  id: "ell-1",
  type: "ellipse",
  x: 0,
  y: 0,
  width: 40,
  height: 40,
  version: 1,
  versionNonce: 456,
  isDeleted: false,
};

function sceneText(overrides = {}) {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [],
    appState: {},
    files: {},
    ...overrides,
  });
}

describe("whiteboardDoc", () => {
  it("parses the scene envelope tolerantly", () => {
    expect(parseSceneText("")).toEqual({ elements: [], appState: {}, files: {} });
    expect(parseSceneText("not json")).toEqual({ elements: [], appState: {}, files: {} });
    expect(parseSceneText('"a string"')).toEqual({ elements: [], appState: {}, files: {} });
    const scene = parseSceneText(sceneText({ elements: [RECT, "junk", ELLIPSE] }));
    expect(scene.elements.map((e) => e.id)).toEqual(["rect-1", "ell-1"]);
  });

  it("seeds and serializes a scene round-trip", () => {
    const raw = sceneText({
      elements: [RECT, ELLIPSE],
      appState: { viewBackgroundColor: CANVAS_LIGHT, gridSize: 20 },
      files: { f1: { id: "f1", mimeType: "image/png", dataURL: "data:..." } },
    });
    const doc = new Y.Doc();
    seedWhiteboard(doc, raw);
    expect(whiteboardIsEmpty(doc)).toBe(false);
    const again = serializeScene(doc);
    expect(again).toBe(whiteboardSnapshot(raw));
    const read = readScene(doc);
    expect(read.elements.map((e) => e.id)).toEqual(["rect-1", "ell-1"]);
    expect(read.appState.viewBackgroundColor).toBe(CANVAS_LIGHT);
    expect(read.files.f1.mimeType).toBe("image/png");
    doc.destroy();
  });

  it("applies only the diff — unchanged elements keep their entries", () => {
    const doc = new Y.Doc();
    seedWhiteboard(doc, sceneText({ elements: [RECT] }));
    const updates = [];
    doc.on("update", (u) => updates.push(u));
    // Same element — no update emitted.
    doc.transact(() => applySceneToYDoc(doc, { elements: [RECT] }), "local");
    expect(updates).toHaveLength(0);
    // Moved element + deleted ellipse — one update.
    const moved = { ...RECT, x: 99, version: 2, versionNonce: 124 };
    doc.transact(() => applySceneToYDoc(doc, { elements: [moved, ELLIPSE] }), "local");
    expect(updates.length).toBeGreaterThan(0);
    const read = readScene(doc);
    expect(read.elements.map((e) => e.id)).toEqual(["rect-1", "ell-1"]);
    expect(read.elements[0].x).toBe(99);
    doc.destroy();
  });

  it("drops transient appState — selection and collaborators never persist", () => {
    const doc = new Y.Doc();
    applySceneToYDoc(doc, {
      elements: [RECT],
      appState: {
        viewBackgroundColor: CANVAS_BG,
        collaborators: [{ pointer: { x: 1, y: 1 } }],
        selectedElementIds: { "rect-1": true },
        scrollX: 42,
        scrollY: 7,
        zoom: { value: 2 },
        editingElement: { id: "rect-1" },
      },
    });
    const read = readScene(doc);
    expect(read.appState.viewBackgroundColor).toBe(CANVAS_BG);
    expect(read.appState.collaborators).toBeUndefined();
    expect(read.appState.selectedElementIds).toBeUndefined();
    expect(read.appState.scrollX).toBeUndefined();
    expect(read.appState.zoom).toBeUndefined();
    expect(serializeScene(doc)).not.toContain("collaborators");
    expect(serializeScene(doc)).not.toContain("selectedElementIds");
    doc.destroy();
  });

  it("keeps the file's persisted appState keys only", () => {
    const kept = persistedAppState({
      viewBackgroundColor: CANVAS_DARK,
      gridSize: null,
      name: "board",
      exportScale: 2,
      theme: "dark", // runtime prop, not a persisted key
    });
    expect(kept).toEqual({
      viewBackgroundColor: CANVAS_DARK,
      gridSize: null,
      name: "board",
      exportScale: 2,
    });
  });

  it("two docs converge when both edit different elements", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedWhiteboard(a, sceneText({ elements: [RECT] }));
    // Hand b the initial state, then diverge. The editor re-syncs the
    // diff cache on every remote update; do the same here.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    syncSceneCache(b);
    a.transact(
      () => applySceneToYDoc(a, { elements: [{ ...RECT, x: 1, version: 2, versionNonce: 124 }] }),
      "local",
    );
    b.transact(
      () => applySceneToYDoc(b, { elements: [RECT, ELLIPSE] }),
      "local",
    );
    // Exchange updates both ways.
    const svA = Y.encodeStateVector(a);
    const svB = Y.encodeStateVector(b);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, svA), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, svB), "remote");
    expect(serializeScene(a)).toBe(serializeScene(b));
    const read = readScene(a);
    const byId = Object.fromEntries(read.elements.map((e) => [e.id, e]));
    expect(byId["rect-1"].x).toBe(1);
    expect(byId["ell-1"]).toBeTruthy();
    a.destroy();
    b.destroy();
  });

  it("a stale local frame never overwrites a newer remote element", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedWhiteboard(a, sceneText({ elements: [RECT] }));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    syncSceneCache(b);
    // a moves the rectangle; b hears it, and so does b's diff cache.
    a.transact(
      () => applySceneToYDoc(a, { elements: [{ ...RECT, x: 5, version: 2, versionNonce: 9 }] }),
      "local",
    );
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "remote");
    syncSceneCache(b);
    const updates = [];
    b.on("update", (u) => updates.push(u));
    // b's editor flushes a frame captured before the remote apply (old
    // version) and then echoes the applied scene (same version): neither
    // writes anything.
    b.transact(() => applySceneToYDoc(b, { elements: [RECT] }), "local");
    b.transact(
      () => applySceneToYDoc(b, { elements: [{ ...RECT, x: 5, version: 2, versionNonce: 9 }] }),
      "local",
    );
    expect(updates).toHaveLength(0);
    expect(readScene(b).elements[0].x).toBe(5);
    a.destroy();
    b.destroy();
  });

  it("keeps a peer's new element the local editor hasn't received yet", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedWhiteboard(a, sceneText({ elements: [RECT] }));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    syncSceneCache(b);
    a.transact(() => applySceneToYDoc(a, { elements: [RECT, ELLIPSE] }), "local");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "remote");
    syncSceneCache(b);
    // b's canvas still only lists the rectangle for one more frame.
    b.transact(() => applySceneToYDoc(b, { elements: [RECT] }), "local");
    expect(readScene(b).elements.map((e) => e.id)).toContain("ell-1");
    a.destroy();
    b.destroy();
  });

  it("seeds a solo collab session from the file", () => {
    const sync = new CollabDocSync({
      driveId: "d",
      path: "board.excalidraw",
      solo: true,
      adapter: whiteboardCollabAdapter(),
    });
    sync.connect();
    sync.adoptContent(BLANK_EXCALIDRAW_JSON);
    expect(sync.hydrated).toBe(true);
    expect(sync.serialize()).toBe(whiteboardSnapshot(BLANK_EXCALIDRAW_JSON));
    sync.destroy();
  });

  it("adapter matchesSeed tolerates formatting differences", () => {
    const sync = new CollabDocSync({
      driveId: "d",
      path: "board.excalidraw",
      solo: true,
      adapter: whiteboardCollabAdapter(),
    });
    sync.connect();
    // Minified equivalent of the canonical blank — same scene, different bytes.
    sync.adoptContent('{"type":"excalidraw","version":2,"source":"x","elements":[],"appState":{},"files":{}}');
    expect(sync.hydrated).toBe(true);
    sync.destroy();
  });
});
