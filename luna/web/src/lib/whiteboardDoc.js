/**
 * The shared whiteboard document inside a Yjs doc.
 *
 * Text files sync a Y.Text; forms sync a Y.Map. A whiteboard scene is a
 * set of canvas elements — the natural shape is the same one Excalidraw's
 * own collab server uses: a `Y.Map` keyed by element id, plus a `Y.Array`
 * of ids for z-order. Two people dragging different shapes touch different
 * map entries, so edits merge instead of fighting over one JSON blob.
 *
 *   scene (Y.Map)
 *     elements   Y.Map<elementId, JSON string>
 *     order      Y.Array<elementId>     — z-order; the map is unordered
 *     appState   Y.Map<key, JSON string> — persisted scene settings only
 *     files      Y.Map<fileId, JSON string> — embedded images (BinaryFileData)
 *
 * The file on the drive is still the scene JSON envelope — `serialize`
 * below is the only translation. Kept dependency-free on purpose: the
 * adapter must run before the Excalidraw chunk has loaded (and in tests
 * that never load it).
 */

import * as Y from "yjs";
import { WHITEBOARD_SOURCE } from "./whiteboardFile.js";

/**
 * Scene-level appState keys that belong in the file. Everything else —
 * selection, scroll, zoom, collaborators, editing element — is per-client
 * UI state and must not sync or persist. Mirrors the subset upstream's
 * serializeAsJSON keeps on export.
 */
export const PERSISTED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "name",
  "exportBackground",
  "exportWithDarkMode",
  "exportEmbedScene",
  "exportScale",
  "frameRendering",
];

/** @param {Y.Doc} ydoc */
export function sceneMap(ydoc) {
  return ydoc.getMap("scene");
}

/** Read view of the nested elements map — never creates it. */
function elementsMap(ydoc) {
  const m = sceneMap(ydoc).get("elements");
  return m instanceof Y.Map ? m : null;
}

function orderList(ydoc) {
  const l = sceneMap(ydoc).get("order");
  return l instanceof Y.Array ? l : null;
}

function appStateMap(ydoc) {
  const m = sceneMap(ydoc).get("appState");
  return m instanceof Y.Map ? m : null;
}

function filesMap(ydoc) {
  const m = sceneMap(ydoc).get("files");
  return m instanceof Y.Map ? m : null;
}

/**
 * Write view — creates the nested maps on first write. Callers must be
 * inside a transact or an explicit edit.
 * @param {Y.Doc} ydoc
 */
function ensureScene(ydoc) {
  const scene = sceneMap(ydoc);
  let elements = scene.get("elements");
  if (!(elements instanceof Y.Map)) {
    elements = new Y.Map();
    scene.set("elements", elements);
  }
  let order = scene.get("order");
  if (!(order instanceof Y.Array)) {
    order = new Y.Array();
    scene.set("order", order);
  }
  let appState = scene.get("appState");
  if (!(appState instanceof Y.Map)) {
    appState = new Y.Map();
    scene.set("appState", appState);
  }
  let files = scene.get("files");
  if (!(files instanceof Y.Map)) {
    files = new Y.Map();
    scene.set("files", files);
  }
  return { elements, order, appState, files };
}

/** @param {unknown} value */
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keep only the persisted appState slice. Unknown/missing keys are dropped;
 * anything unserializable is dropped rather than breaking the write.
 * @param {object | null | undefined} appState
 */
export function persistedAppState(appState) {
  const out = {};
  if (!isObject(appState)) return out;
  for (const key of PERSISTED_APP_STATE_KEYS) {
    if (appState[key] === undefined) continue;
    try {
      const json = JSON.stringify(appState[key]);
      if (json !== undefined) out[key] = appState[key];
    } catch {
      // unserializable value — leave it out of the document
    }
  }
  return out;
}

/**
 * Pull a scene {elements, appState, files} out of raw `.excalidraw` text.
 * Tolerant: a non-JSON or non-scene body seeds blank rather than throwing —
 * the create-kind file is valid from byte zero, and a hand-made empty or
 * corrupt file should open as a blank canvas, not an error screen.
 * @param {string} content
 * @returns {{ elements: object[], appState: object, files: Record<string, object> }}
 */
export function parseSceneText(content) {
  const empty = { elements: [], appState: {}, files: {} };
  const text = String(content || "").trim();
  if (!text) return empty;
  try {
    const data = JSON.parse(text);
    if (!isObject(data)) return empty;
    return {
      elements: Array.isArray(data.elements) ? data.elements.filter(isObject) : [],
      appState: isObject(data.appState) ? data.appState : {},
      files: isObject(data.files) ? data.files : {},
    };
  } catch {
    return empty;
  }
}

/**
 * Per-doc mirror of what the Y.Doc holds, so the per-frame onChange diff can
 * skip unchanged entries without stringifying them:
 *   elements  id → { version, versionNonce, json, local }
 *   files     id → { ref, json, local } — `ref` is the BinaryFileData
 *             object last written, so an unchanged image (often megabytes
 *             of dataURL) is never re-stringified
 * `local` marks entries this client wrote; only those may be deleted when
 * the editor's scene stops listing them (see applySceneToYDoc).
 */
const ydocCaches = new WeakMap();

function getSceneCache(ydoc) {
  let cache = ydocCaches.get(ydoc);
  if (!cache) {
    cache = {
      elements: new Map(),
      order: [],
      appState: new Map(),
      files: new Map(),
    };
    ydocCaches.set(ydoc, cache);
  }
  return cache;
}

export function resetSceneCache(ydoc) {
  ydocCaches.delete(ydoc);
}

/**
 * True when an incoming element must not overwrite what the doc holds:
 * same edit, or an older/losing one. Mirrors Excalidraw's reconcile rule —
 * higher version wins, a version tie goes to the lower versionNonce — so a
 * scene captured a frame before a remote apply can't clobber the peer's
 * newer shape.
 */
function isStaleElement(cached, version, versionNonce) {
  if (version < cached.version) return true;
  if (version > cached.version) return false;
  return !(versionNonce < cached.versionNonce);
}

/**
 * Write a scene into the shared doc. Used by `seed` (first peer adopts the
 * file) and by local `onChange` (diff-write). Only writes what changed —
 * unchanged elements keep their map entries, so the emitted Yjs update is
 * proportional to the edit, not the scene.
 *
 * Excalidraw bumps `version` (and re-rolls `versionNonce`) on every edit,
 * so versioned elements are compared by version alone and only stringified
 * when they actually changed.
 *
 * @param {Y.Doc} ydoc
 * @param {{ elements?: object[] | readonly object[], appState?: object, files?: Record<string, object> }} scene
 * @returns {boolean} true if any document mutation was applied
 */
export function applySceneToYDoc(ydoc, scene) {
  const { elements, order, appState, files } = ensureScene(ydoc);
  const list = Array.isArray(scene?.elements) ? scene.elements : [];
  const cache = getSceneCache(ydoc);
  let changed = false;

  // Elements: set changed, drop removed.
  const incoming = new Set();
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    const id = el && typeof el.id === "string" ? el.id : null;
    if (!id || incoming.has(id)) continue;
    incoming.add(id);

    const cached = cache.elements.get(id);
    const version = typeof el.version === "number" ? el.version : null;
    const versionNonce = el.versionNonce;
    if (cached && version != null && cached.version != null) {
      if (isStaleElement(cached, version, versionNonce)) continue;
    }

    const json = JSON.stringify(el);
    if (!cached || cached.json !== json) {
      elements.set(id, json);
      changed = true;
    }
    cache.elements.set(id, { version, versionNonce, json, local: true });
  }

  // An element this client wrote that the scene no longer lists was removed
  // here. Entries a peer added are left alone: the editor may simply not
  // have received them yet (the remote push lands a frame later).
  if (cache.elements.size !== incoming.size) {
    for (const [key, entry] of [...cache.elements]) {
      if (!incoming.has(key) && entry.local) {
        elements.delete(key);
        cache.elements.delete(key);
        changed = true;
      }
    }
  }

  // Z-order: check against cached list first to avoid traversing Y.Array
  let orderDiffers = list.length !== cache.order.length;
  if (!orderDiffers) {
    for (let i = 0; i < list.length; i++) {
      if (list[i]?.id !== cache.order[i]) {
        orderDiffers = true;
        break;
      }
    }
  }

  if (orderDiffers) {
    const nextOrder = list.map((el) => el?.id).filter((id) => typeof id === "string");
    const current = order.toArray();
    if (
      nextOrder.length !== current.length ||
      nextOrder.some((id, i) => id !== current[i])
    ) {
      if (current.length) order.delete(0, current.length);
      if (nextOrder.length) order.push(nextOrder);
      changed = true;
    }
    cache.order = nextOrder;
  }

  // Scene settings: only the persisted subset, keyed compare.
  const nextApp = persistedAppState(scene?.appState);
  for (const key of PERSISTED_APP_STATE_KEYS) {
    const has = key in nextApp;
    const json = has ? JSON.stringify(nextApp[key]) : undefined;
    const cachedJson = cache.appState.get(key);
    if (!has) {
      if (cachedJson !== undefined || appState.has(key)) {
        appState.delete(key);
        cache.appState.delete(key);
        changed = true;
      }
    } else if (cachedJson !== json) {
      appState.set(key, json);
      cache.appState.set(key, json);
      changed = true;
    }
  }

  // Embedded images: add/replace on change, drop removed ids.
  const nextFiles = isObject(scene?.files) ? scene.files : {};
  const nextIds = new Set(Object.keys(nextFiles));
  for (const id of nextIds) {
    const file = nextFiles[id];
    const cached = cache.files.get(id);
    if (cached && cached.ref === file) continue;
    const json = JSON.stringify(file);
    if (json === undefined) continue;
    if (!cached || cached.json !== json) {
      files.set(id, json);
      changed = true;
    }
    cache.files.set(id, { ref: file, json, local: true });
  }
  for (const [id, entry] of [...cache.files]) {
    if (!nextIds.has(id) && entry.local) {
      files.delete(id);
      cache.files.delete(id);
      changed = true;
    }
  }

  return changed;
}

/**
 * Re-sync the diff cache after a remote update so the editor's echo of the
 * applied scene (same versions) is a no-op instead of re-broadcasting the
 * peer's edit, and so a stale local frame can't overwrite a newer remote
 * element. Cheap when little changed: unchanged entries are the same
 * string instance and skip on identity.
 * @param {Y.Doc} ydoc
 */
export function syncSceneCache(ydoc) {
  const cache = getSceneCache(ydoc);
  const elements = elementsMap(ydoc);
  if (elements) {
    elements.forEach((raw, id) => {
      if (typeof raw !== "string") return;
      const cached = cache.elements.get(id);
      if (cached && cached.json === raw) return;
      try {
        const el = JSON.parse(raw);
        cache.elements.set(id, {
          version: typeof el?.version === "number" ? el.version : null,
          versionNonce: el?.versionNonce,
          json: raw,
          local: false,
        });
      } catch {
        cache.elements.delete(id);
      }
    });
    for (const id of [...cache.elements.keys()]) {
      if (!elements.has(id)) cache.elements.delete(id);
    }
  }
  const order = orderList(ydoc);
  if (order) cache.order = order.toArray();
  const appState = appStateMap(ydoc);
  if (appState) {
    cache.appState.clear();
    appState.forEach((raw, key) => {
      if (typeof raw === "string") cache.appState.set(key, raw);
    });
  }
  const files = filesMap(ydoc);
  if (files) {
    files.forEach((raw, id) => {
      if (typeof raw !== "string") return;
      if (cache.files.get(id)?.json !== raw) cache.files.set(id, { ref: null, json: raw, local: false });
    });
    for (const id of [...cache.files.keys()]) {
      if (!files.has(id)) cache.files.delete(id);
    }
  }
}

/**
 * Read the shared doc back into a scene object for the editor or for
 * `serialize`. Order comes from the `order` array; an element whose id is
 * missing from it (a concurrent-insert race) appends after, sorted by id
 * so every peer resolves the same layout.
 * @param {Y.Doc} ydoc
 */
export function readScene(ydoc) {
  const elements = elementsMap(ydoc);
  const order = orderList(ydoc);
  const appState = appStateMap(ydoc);
  const files = filesMap(ydoc);

  /** @type {object[]} */
  const list = [];
  if (elements) {
    const seen = new Set();
    if (order) {
      for (const id of order.toArray()) {
        if (seen.has(id)) continue;
        const raw = elements.get(id);
        if (typeof raw !== "string") continue;
        seen.add(id);
        try {
          list.push(JSON.parse(raw));
        } catch {
          // drop a malformed entry rather than losing the whole scene
        }
      }
    }
    const extra = [...elements.keys()]
      .filter((id) => !seen.has(id))
      .sort();
    for (const id of extra) {
      try {
        list.push(JSON.parse(elements.get(id)));
      } catch {
        // same
      }
    }
  }

  /** @type {Record<string, unknown>} */
  const app = {};
  if (appState) {
    for (const key of PERSISTED_APP_STATE_KEYS) {
      const raw = appState.get(key);
      if (typeof raw !== "string") continue;
      try {
        app[key] = JSON.parse(raw);
      } catch {
        // skip
      }
    }
  }

  /** @type {Record<string, object>} */
  const fileMap = {};
  if (files) {
    files.forEach((raw, id) => {
      if (typeof raw !== "string") return;
      try {
        fileMap[id] = JSON.parse(raw);
      } catch {
        // skip
      }
    });
  }

  return { elements: list, appState: app, files: fileMap };
}

/** Canonical `.excalidraw` text — what a save writes to the drive. */
export function serializeScene(ydoc) {
  const { elements, appState, files } = readScene(ydoc);
  return `${JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: WHITEBOARD_SOURCE,
      elements,
      appState,
      files,
    },
    null,
    2,
  )}\n`;
}

/** @param {Y.Doc} ydoc */
export function whiteboardIsEmpty(ydoc) {
  return sceneMap(ydoc).size === 0;
}

/** @param {Y.Doc} ydoc */
export function clearWhiteboard(ydoc) {
  resetSceneCache(ydoc);
  const scene = sceneMap(ydoc);
  const keys = [];
  scene.forEach((_value, key) => keys.push(key));
  for (const key of keys) scene.delete(key);
}

/** @param {Y.Doc} ydoc @param {string} content */
export function seedWhiteboard(ydoc, content) {
  resetSceneCache(ydoc);
  applySceneToYDoc(ydoc, parseSceneText(content));
}

/** Canonical JSON for file bytes, without touching a live Y.Doc. */
export function whiteboardSnapshot(content) {
  const probe = new Y.Doc();
  try {
    seedWhiteboard(probe, content);
    return serializeScene(probe);
  } finally {
    probe.destroy();
  }
}

/**
 * CollabDocSync adapter. The default text adapter is untouched;
 * whiteboards opt in.
 * @returns {import("../components/files/collabDocSync.js").DocAdapter}
 */
export function whiteboardCollabAdapter() {
  return {
    isEmpty: (ydoc) => whiteboardIsEmpty(ydoc),
    seed: (ydoc, content) => {
      seedWhiteboard(ydoc, content);
    },
    serialize: (ydoc) => serializeScene(ydoc),
    // Whiteboards are keyed by element ID in a Y.Map; concurrent seeds merge
    // cleanly without duplicating. Never wipe the canvas on join/reconnect.
    matchesSeed: () => false,
    clear: () => {},
  };
}
