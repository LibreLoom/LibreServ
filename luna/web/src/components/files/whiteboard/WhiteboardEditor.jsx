import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import EditorLoadingScreen from "../EditorLoadingScreen.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { useTheme } from "@libreloom/ui/hooks/useTheme.jsx";
import { apiErrorMessage } from "../../../lib/api.js";
import { pathBasename } from "../../../lib/paths.js";
import { requireOk, useFileSource } from "../../../lib/fileSource.jsx";
import { useOptionalAuth } from "../../../context/AuthContext.jsx";
import { CollabDocSync } from "../collabDocSync.js";
import { CollabSocket } from "../office/collabSocket.js";
import { collabPresenceLabel } from "../collabPresence.js";
import OfficeIssueCard from "../office/OfficeIssueCard.jsx";
import {
  applySceneToYDoc,
  readScene,
  syncSceneCache,
  whiteboardCollabAdapter,
  whiteboardSnapshot,
} from "../../../lib/whiteboardDoc.js";
import { WHITEBOARD_MIME } from "../../../lib/whiteboardFile.js";

// Autosave mirrors FormBuilder/TextFileEditor: fire once editing pauses for
// AUTOSAVE_IDLE_MS, never let unsaved work age past AUTOSAVE_MAX_MS during
// continuous editing, and back off AUTOSAVE_RETRY_MS after a failed save.
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MAX_MS = 15_000;
const AUTOSAVE_RETRY_MS = 5_000;
const AUTOSAVE_TICK_MS = 250;
/** Pointer broadcasts are presence traffic — 20fps is plenty. */
const POINTER_THROTTLE_MS = 50;
/** Local canvas edits reach the shared doc (and peers) at most ~30 times a
 * second — smooth for watchers, and a fraction of per-frame writes on
 * 120/144Hz screens. The local canvas never waits on it. */
const LOCAL_SYNC_MS = 32;
/** Alone in the room nobody watches the stroke live, so the doc is written
 * once the canvas goes quiet (like excalidraw.com's own local save) —
 * nothing runs mid-gesture. SOLO_SYNC_MAX_MS bounds how stale the doc (and
 * the unsaved-changes flag) may get while the pointer never rests. */
const SOLO_SYNC_IDLE_MS = 250;
const SOLO_SYNC_MAX_MS = 1_000;
/** Longest we hold the canvas back for an entrance animation. */
const SETTLE_TIMEOUT_MS = 1_000;
/** Give a silent room this long to answer the sync handshake before
 * mounting whatever the doc holds (the in-sync fallback seeds anyway). */
const HYDRATE_TIMEOUT_MS = 10_000;
const HYDRATE_POLL_MS = 50;

const EMPTY_OBJECT = Object.freeze({});

/**
 * Resolve once every running animation on an ancestor of `el` (the
 * fullscreen frame's zoom-in) has finished. Excalidraw measures its
 * container once on mount with getBoundingClientRect, which includes
 * ancestor transforms — mounting mid-zoom leaves a canvas a few pixels
 * short and fractionally sized for good (a transform ending fires no
 * resize), so the browser resamples it every frame and pointer math runs
 * off a stale offset.
 * @param {Element | null} el
 */
function ancestorAnimationsSettled(el) {
  if (!el || typeof document.getAnimations !== "function") return Promise.resolve();
  const running = document.getAnimations().filter((anim) => {
    const target = /** @type {KeyframeEffect | null} */ (anim.effect)?.target;
    const timing = anim.effect?.getTiming?.();
    return (
      anim.playState === "running" &&
      timing?.iterations !== Infinity &&
      target instanceof Element &&
      target !== el &&
      target.contains(el)
    );
  });
  if (!running.length) return Promise.resolve();
  return Promise.race([
    Promise.all(running.map((anim) => anim.finished.catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
  ]);
}

const UI_OPTIONS = Object.freeze({
  canvasActions: {
    // Luna owns file open/save — the editor's own file
    // buttons would bypass the frame's save contract.
    loadScene: false,
    saveToActiveFile: false,
    toggleTheme: false,
    clearCanvas: false,
    export: false,
  },
});

function areShallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function areCollaboratorsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  for (const [id, valA] of a) {
    const valB = b.get(id);
    if (!valB) return false;
    if (valA.button !== valB.button) return false;
    if (valA.username !== valB.username) return false;
    if (valA.userState !== valB.userState) return false;
    if (valA.color?.background !== valB.color?.background) return false;
    if (valA.pointer?.x !== valB.pointer?.x || valA.pointer?.y !== valB.pointer?.y) return false;
    if (!areShallowEqual(valA.selectedElementIds, valB.selectedElementIds)) return false;
  }
  return true;
}

let excalidrawPromise = null;
/** The resolved `@excalidraw/excalidraw` module, set by loadExcalidraw. */
let excalidraw = null;

/**
 * The editor is a ~1MB chunk — load it on first open, never in the main
 * bundle. EXCALIDRAW_ASSET_PATH must be set before the module evaluates:
 * the font loader reads it lazily, but its default is a CDN Luna must
 * never touch. Fonts are served from /excalidraw (vite config).
 *
 * EXCALIDRAW_THROTTLE_RENDER is what excalidraw.com itself sets: canvas
 * redraws coalesce to one per animation frame. Without it every pointer
 * event repaints the whole scene synchronously, and high-rate mice/pens
 * stack several redraws into one frame — the canvas visibly stutters.
 */
function loadExcalidraw() {
  /** @type {any} */ (window).EXCALIDRAW_ASSET_PATH = "/excalidraw/";
  /** @type {any} */ (window).EXCALIDRAW_THROTTLE_RENDER = true;
  if (!excalidrawPromise) {
    excalidrawPromise = Promise.all([
      import("@excalidraw/excalidraw"),
      import("@excalidraw/excalidraw/index.css"),
    ]).then(([mod]) => (excalidraw = mod));
  }
  return excalidrawPromise;
}

const ExcalidrawLazy = lazy(() =>
  loadExcalidraw().then(() => ({ default: excalidraw.Excalidraw })),
);

/**
 * Error boundary that catches any runtime crash inside Excalidraw or its
 * subcomponents, preventing the entire React root from unmounting.
 * @extends {Component<{ downloadUrl?: string, downloadName?: string, onClose?: () => void, onRetry?: () => void, children?: import("react").ReactNode }>}
 */
class WhiteboardErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Whiteboard editor crashed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <OfficeIssueCard
          title="Luna couldn't display this whiteboard"
          downloadUrl={this.props.downloadUrl}
          downloadName={this.props.downloadName}
          onClose={this.props.onClose}
          onRetry={() => {
            this.setState({ error: null });
            this.props.onRetry?.();
          }}
        >
          <PageNotice variant="error">
            The whiteboard view crashed. Your file on the drive hasn&rsquo;t changed.
          </PageNotice>
        </OfficeIssueCard>
      );
    }
    return this.props.children;
  }
}

WhiteboardErrorBoundary.propTypes = {
  downloadUrl: PropTypes.string,
  downloadName: PropTypes.string,
  onClose: PropTypes.func,
  onRetry: PropTypes.func,
  children: PropTypes.node,
};

/**
 * Fullscreen Excalidraw whiteboard — mounts inside FileViewer's
 * FullscreenEditorFrame and plugs into its save contract.
 *
 * Live edits ride the same CollabDocSync hub as text files and forms: the
 * scene lives in a Y.Map keyed by element id (see lib/whiteboardDoc.js),
 * so two people drawing different shapes merge instead of clobbering.
 * Remote applies go through excalidraw's reconcileElements, which lets an
 * in-flight local drag win over an incoming snapshot. Saves write the
 * canonical scene JSON through the normal upload path — same as forms.
 * Share-link guests join the same room over /s/{token}/collab/ws.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onClose?: () => void,
 *   onPresenceChange?: (label: string) => void,
 *   onRegisterSave?: (save: (() => Promise<unknown>) | null) => void,
 *   onSaveStateChange?: (hasUnsaved: boolean) => void,
 *   requestClose?: () => void,
 *   onRetry?: () => void,
 * }} props
 */
export default function WhiteboardEditor({ onRetry = undefined, ...props }) {
  const [attempt, setAttempt] = useState(0);
  const source = useFileSource();
  const name = pathBasename(props.path) || props.path;
  const retry = onRetry || (() => setAttempt((n) => n + 1));
  return (
    <WhiteboardErrorBoundary
      downloadUrl={source.downloadHref(props.driveId, props.path)}
      downloadName={name}
      onClose={props.onClose}
      onRetry={retry}
    >
      <EditorSession
        key={`${props.driveId}:${props.path}:${attempt}`}
        {...props}
        onRetry={retry}
      />
    </WhiteboardErrorBoundary>
  );
}

WhiteboardEditor.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onClose: PropTypes.func,
  onPresenceChange: PropTypes.func,
  onRegisterSave: PropTypes.func,
  onSaveStateChange: PropTypes.func,
  requestClose: PropTypes.func,
  onRetry: PropTypes.func,
};

/** @param {Parameters<typeof WhiteboardEditor>[0]} props */
function EditorSession({
  driveId,
  path,
  canWrite = false,
  onSaved,
  onClose,
  onPresenceChange,
  onRegisterSave,
  onSaveStateChange,
  onRetry,
}) {
  const name = pathBasename(path) || path;
  const source = useFileSource();
  const auth = useOptionalAuth();
  const user = source.guest ? null : auth?.user;
  const selfName = user?.display_name || user?.username || "";
  const { resolvedTheme } = useTheme();
  const [phase, setPhase] = useState(
    /** @type {"loading" | "ready" | "error"} */ ("loading"),
  );
  const [error, setError] = useState("");
  const [peers, setPeers] = useState(/** @type {object[]} */ ([]));
  const [connStatus, setConnStatus] = useState("connecting");
  const [initialData, setInitialData] = useState(/** @type {object | null} */ (null));
  const [editorReady, setEditorReady] = useState(false);

  const apiRef = useRef(/** @type {import("@excalidraw/excalidraw/types").ExcalidrawImperativeAPI | null} */ (null));
  const collaboratorsRef = useRef(new Map());
  const syncRef = useRef(/** @type {CollabDocSync | null} */ (null));
  const baselineRef = useRef(/** @type {string | null} */ (null));
  const dirtyRef = useRef(false);
  const lastEditRef = useRef(0);
  const dirtySinceRef = useRef(0);
  const lastSaveAttemptRef = useRef(0);
  const savingRef = useRef(false);
  const lastPointerRef = useRef(0);
  const onSavedRef = useRef(onSaved);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const onPresenceChangeRef = useRef(onPresenceChange);
  const onCloseRef = useRef(onClose);
  onSavedRef.current = onSaved;
  onSaveStateChangeRef.current = onSaveStateChange;
  onPresenceChangeRef.current = onPresenceChange;
  onCloseRef.current = onClose;

  // One CollabDocSync per mount — the parent remounts this session for
  // retries (key on driveId:path:attempt), so no in-place reset is needed.
  const [sync] = useState(() => {
    const solo = source.collab === false;
    const url = source.collabWsUrl?.(driveId, path);
    return new CollabDocSync({
      driveId,
      path,
      solo,
      socket: url ? () => new CollabSocket(driveId, path, url) : undefined,
      adapter: whiteboardCollabAdapter(),
      onPeers: (next) => setPeers(next),
      onStatus: (status) => setConnStatus(status),
      onPeerSaved: () => {
        // Their file contains everything the shared doc holds. Adopting our
        // own serialize as the baseline mirrors FormBuilder — an op still in
        // flight rides the next autosave instead.
        const session = syncRef.current;
        if (!session) return;
        const body = session.serialize();
        baselineRef.current = body;
        dirtyRef.current = false;
        dirtySinceRef.current = 0;
        onSaveStateChangeRef.current?.(false);
      },
    });
  });
  syncRef.current = sync;

  const presenceStatus =
    phase === "ready"
      ? connStatus === "open" || sync._offline
        ? "ready"
        : connStatus === "closed" || connStatus === "error"
          ? "error"
          : "loading"
      : phase === "error"
        ? "error"
        : "loading";

  useEffect(() => {
    onPresenceChangeRef.current?.(
      collabPresenceLabel(
        presenceStatus,
        peers,
        canWrite,
        selfName,
        sync.peerId,
        "Opening this whiteboard…",
      ),
    );
  }, [presenceStatus, peers, canWrite, selfName, sync]);

  const markDirty = useCallback(() => {
    // Real doc changes only — onChange also fires for hover, scroll and
    // selection, which must not keep pushing the idle autosave back.
    lastEditRef.current = Date.now();
    dirtyRef.current = true;
    if (!dirtySinceRef.current) dirtySinceRef.current = Date.now();
    onSaveStateChangeRef.current?.(true);
  }, []);

  const isApplyingSceneRef = useRef(false);
  const hostRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const selectedElementIdsRef = useRef(EMPTY_OBJECT);

  /** Push the shared doc into the mounted canvas — remote path. */
  const pushSceneToEditor = useCallback(() => {
    const api = apiRef.current;
    const session = syncRef.current;
    const mod = excalidraw;
    if (!api || !session || !mod) return;
    const { elements, appState, files } = readScene(session.ydoc);
    const patch = {};
    for (const [key, value] of Object.entries(appState)) {
      if (value !== undefined) patch[key] = value;
    }
    const update = { appState: patch, collaborators: collaboratorsRef.current };
    if (mod.CaptureUpdateAction) {
      // Remote edits must not land in this client's local undo stack.
      update.captureUpdate = mod.CaptureUpdateAction.NEVER;
    }
    update.elements = mod.reconcileElements
      ? mod.reconcileElements(api.getSceneElements(), elements, api.getAppState())
      : elements;
    const known = api.getFiles() || {};
    const missing = Object.values(files).filter((f) => f && !known[f.id]);
    if (missing.length) api.addFiles(missing);
    isApplyingSceneRef.current = true;
    try {
      api.updateScene(update);
    } finally {
      queueMicrotask(() => {
        isApplyingSceneRef.current = false;
      });
    }
  }, []);

  /** Peer cursors + selections ride awareness — same channel as forms. */
  const pushCollaborators = useCallback(() => {
    const api = apiRef.current;
    const session = syncRef.current;
    if (!api || !session) return;
    const localId = session.ydoc.clientID;
    const map = new Map();
    for (const [clientId, state] of session.awareness.getStates()) {
      if (clientId === localId || !state) continue;
      const raw = typeof state.user?.color === "string" ? state.user.color : "";
      // Excalidraw paints peer cursors on a canvas — it needs a real hex.
      const color = /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : "#767676"; // color-scan: ignore-line canvas peer color, not a CSS surface
      map.set(String(clientId), {
        pointer: state.pointer || undefined,
        button: state.button || "up",
        selectedElementIds: state.selectedElementIds || EMPTY_OBJECT,
        username: state.user?.name || "Someone",
        userState: "active",
        color: { background: color, stroke: color },
        id: String(clientId),
      });
    }
    if (areCollaboratorsEqual(collaboratorsRef.current, map)) {
      return;
    }
    collaboratorsRef.current = map;
    api.updateScene({ collaborators: map });
  }, []);

  const handleExcalidrawAPI = useCallback(
    (api) => {
      apiRef.current = api;
      // Excalidraw calls excalidrawAPI synchronously inside its App constructor
      // before mounting. Defer collaborator updates and setting ready state until after mount
      // to avoid calling setState on an unmounted component or triggering parent re-renders.
      queueMicrotask(() => {
        if (!apiRef.current) return;
        pushCollaborators();
        setEditorReady(true);
      });
    },
    [pushCollaborators],
  );

  // A peer dragging a shape sends an update per frame (or several, when
  // their frames outpace ours) — apply at most one scene per frame here.
  const remoteRafRef = useRef(/** @type {number | null} */ (null));
  const scheduleRemotePush = useCallback(() => {
    if (remoteRafRef.current != null) return;
    remoteRafRef.current = requestAnimationFrame(() => {
      remoteRafRef.current = null;
      pushSceneToEditor();
    });
  }, [pushSceneToEditor]);

  // Load the file, join the room, mount the canvas once the doc is hydrated.
  useEffect(() => {
    let cancelled = false;
    const session = sync;

    const onYUpdate = (_update, origin) => {
      if (cancelled) return;
      if (origin === "remote") {
        syncSceneCache(session.ydoc);
        scheduleRemotePush();
      }
      // The seed is the file itself — only real edits mark the doc dirty.
      if (origin !== "seed") markDirty();
    };
    const onAwarenessUpdate = ({ added, updated, removed }) => {
      if (cancelled) return;
      const localId = session.ydoc.clientID;
      const hasRemote = [...added, ...updated, ...removed].some((id) => id !== localId);
      if (hasRemote) {
        pushCollaborators();
      }
    };
    session.ydoc.on("update", onYUpdate);
    session.awareness.on("update", onAwarenessUpdate);
    session.connect();

    (async () => {
      let text;
      try {
        if (typeof source.fetchText === "function") {
          text = await source.fetchText(driveId, path);
        } else {
          const res = await source.fetch(source.contentHref(driveId, path));
          await requireOk(res, "Luna couldn't open this file.");
          text = await res.text();
        }
      } catch (err) {
        if (!cancelled) {
          setPhase("error");
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
        }
        return;
      }
      if (cancelled) return;
      // The dirty baseline is the canonical form of what's on the drive —
      // key order or whitespace differences must not open the file dirty.
      baselineRef.current = whiteboardSnapshot(text);
      session.adoptContent(text);
      // Hydration: alone → the seed adopted; joining → wait for the room's
      // scene (CollabDocSync's own fallback seeds on timeout anyway). Solo
      // and dead-hub sessions never see a welcome, so gate on `hydrated`,
      // never on `session.ready`.
      const started = Date.now();
      while (!cancelled && !session.hydrated && Date.now() - started < HYDRATE_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, HYDRATE_POLL_MS));
      }
      if (cancelled) return;
      const mod = await loadExcalidraw();
      if (cancelled) return;
      await ancestorAnimationsSettled(hostRef.current);
      if (cancelled) return;
      const scene = readScene(session.ydoc);
      const restored = mod.restore
        ? mod.restore(
            { elements: scene.elements, appState: scene.appState, files: scene.files },
            null,
            null,
          )
        : scene;
      setInitialData({
        elements: restored.elements,
        appState: restored.appState,
        files: restored.files,
        scrollToContent: true,
      });
      setPhase("ready");
    })();

    return () => {
      cancelled = true;
      session.ydoc.off("update", onYUpdate);
      session.awareness.off("update", onAwarenessUpdate);
      if (remoteRafRef.current != null) {
        cancelAnimationFrame(remoteRafRef.current);
        remoteRafRef.current = null;
      }
      // Disconnect rather than destroy: StrictMode replays this effect, and
      // the same document must survive into the second mount.
      session.disconnect();
    };
  }, [sync, source, driveId, path, markDirty, scheduleRemotePush, pushCollaborators]);

  const pendingSceneRef = useRef(null);
  const syncTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const lastSyncRef = useRef(0);
  const pendingSinceRef = useRef(0);

  const flushScene = useCallback(() => {
    if (syncTimerRef.current != null) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    const pending = pendingSceneRef.current;
    if (!pending) return;
    pendingSceneRef.current = null;
    pendingSinceRef.current = 0;
    lastSyncRef.current = performance.now();
    const session = syncRef.current;
    // No isApplyingSceneRef check here: the pending scene was captured from
    // a real local change, and the doc's version check already refuses to
    // let anything older overwrite a peer's newer element.
    if (!session || !session.hydrated || !canWrite) return;
    session.ydoc.transact(() => {
      applySceneToYDoc(session.ydoc, pending);
    }, "local");
  }, [canWrite]);

  /**
   * Local canvas edits → shared doc. Remote applies echo back through
   * onChange but are guarded by isApplyingSceneRef.
   *
   * Excalidraw calls onChange on every render — every pointer move of a
   * drag. Writing the doc each time costs a stringify per moved element
   * plus a Yjs update and a socket frame, and doing it in a rAF callback
   * put that cost in front of every paint. Instead the latest scene is
   * parked and written from a timer task, between frames: at most every
   * LOCAL_SYNC_MS while peers watch, or once the canvas goes quiet when
   * alone. Saves flush synchronously, so nothing is lost.
   */
  const onSceneChange = useCallback(
    (elements, appState, files) => {
      const session = syncRef.current;
      if (!session || !session.hydrated || isApplyingSceneRef.current) return;
      const selected = appState?.selectedElementIds || EMPTY_OBJECT;
      if (!areShallowEqual(selectedElementIdsRef.current, selected)) {
        selectedElementIdsRef.current = selected;
        session.awareness.setLocalStateField("selectedElementIds", selected);
      }
      if (!canWrite) return;
      pendingSceneRef.current = { elements, appState, files };
      const now = performance.now();
      if (!pendingSinceRef.current) pendingSinceRef.current = now;
      let wait;
      if (session.otherPeers().length > 0) {
        // Throttle: a queued write already carries this change.
        if (syncTimerRef.current != null) return;
        wait = Math.max(0, LOCAL_SYNC_MS - (now - lastSyncRef.current));
      } else {
        // Debounce, capped so a never-resting pointer still syncs.
        if (syncTimerRef.current != null) clearTimeout(syncTimerRef.current);
        wait = Math.max(
          0,
          Math.min(SOLO_SYNC_IDLE_MS, SOLO_SYNC_MAX_MS - (now - pendingSinceRef.current)),
        );
      }
      syncTimerRef.current = setTimeout(() => {
        syncTimerRef.current = null;
        flushScene();
      }, wait);
    },
    [canWrite, flushScene],
  );

  // A write still queued at unmount would land in a session that is
  // already gone.
  useEffect(
    () => () => {
      if (syncTimerRef.current != null) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
      pendingSceneRef.current = null;
      pendingSinceRef.current = 0;
    },
    [],
  );

  /** Cursor position for peer cursors — throttled presence updates. */
  const onPointerUpdate = useCallback((payload) => {
    const session = syncRef.current;
    if (!session) return;
    const now = Date.now();
    const button = payload?.button || "up";
    const prev = session.awareness.getLocalState() || {};
    const buttonChanged = prev.button !== button;
    if (!buttonChanged && now - lastPointerRef.current < POINTER_THROTTLE_MS) {
      return;
    }
    lastPointerRef.current = now;
    const nextPointer = payload?.pointer || null;
    if (
      !buttonChanged &&
      prev.pointer?.x === nextPointer?.x &&
      prev.pointer?.y === nextPointer?.y
    ) {
      return;
    }
    session.awareness.setLocalState({
      ...prev,
      pointer: nextPointer,
      button,
    });
  }, []);

  const save = useCallback(async () => {
    flushScene();
    const session = syncRef.current;
    if (!session || !session.hydrated || !canWrite || savingRef.current) return false;
    const body = session.serialize();
    if (!body) return false;
    savingRef.current = true;
    try {
      await source.saveFile(
        driveId,
        path,
        name,
        new Blob([body], { type: WHITEBOARD_MIME }),
      );
      baselineRef.current = body;
      session.notifySaved(body.length);
      dirtyRef.current = false;
      dirtySinceRef.current = 0;
      onSavedRef.current?.();
      onSaveStateChangeRef.current?.(false);
      return true;
    } finally {
      savingRef.current = false;
    }
  }, [canWrite, source, driveId, path, name, flushScene]);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (phase !== "ready" || !canWrite) return undefined;
    const id = setInterval(() => {
      const session = syncRef.current;
      const now = Date.now();
      if (!dirtyRef.current) {
        dirtySinceRef.current = 0;
        return;
      }
      if (savingRef.current) return;
      const idle = now - lastEditRef.current;
      const stale = now - dirtySinceRef.current;
      // Only serialize and evaluate save if editing is idle or stale —
      // avoids running expensive serializeScene JSON stringification
      // 4 times per second while the user is actively drawing.
      if (idle < AUTOSAVE_IDLE_MS && stale < AUTOSAVE_MAX_MS) {
        return;
      }
      if (now - lastSaveAttemptRef.current < AUTOSAVE_RETRY_MS) return;
      flushScene();
      const dirty =
        session != null &&
        session.hydrated &&
        baselineRef.current != null &&
        session.serialize() !== baselineRef.current;
      if (!dirty) {
        dirtyRef.current = false;
        dirtySinceRef.current = 0;
        onSaveStateChangeRef.current?.(false);
        return;
      }
      lastSaveAttemptRef.current = now;
      saveRef.current?.().catch(() => {
        // keep editing; the tick retries after AUTOSAVE_RETRY_MS
      });
    }, AUTOSAVE_TICK_MS);
    return () => clearInterval(id);
  }, [phase, canWrite, flushScene]);

  // Register the save thunk once the canvas is up — same "no session, no
  // save" contract as the other editors.
  useEffect(() => {
    if (phase !== "ready" || !canWrite || !onRegisterSave) return undefined;
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [phase, canWrite, save, onRegisterSave]);

  // Theme follows Luna's; the prop flips the canvas live.
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  if (phase === "error") {
    const isNotFound = error === "This file doesn't exist anymore.";
    return (
      <OfficeIssueCard
        title="Luna couldn't open this whiteboard"
        downloadUrl={isNotFound ? undefined : source.downloadHref(driveId, path)}
        downloadName={name}
        onClose={onClose}
        onRetry={isNotFound ? undefined : onRetry}
      >
        <PageNotice variant="error">{error}</PageNotice>
      </OfficeIssueCard>
    );
  }

  const showLoading = phase === "loading" || !initialData || !editorReady;

  return (
    <div ref={hostRef} className="relative flex min-h-0 flex-1 flex-col surface-primary">
      {showLoading ? (
        <EditorLoadingScreen
          label={`Opening ${name}`}
          className="absolute inset-0 z-10"
        />
      ) : null}
      {initialData ? (
        <Suspense fallback={null}>
          <div className="h-full min-h-0 w-full flex-1">
            <ExcalidrawLazy
              excalidrawAPI={handleExcalidrawAPI}
              initialData={initialData}
              onChange={onSceneChange}
              onPointerUpdate={onPointerUpdate}
              theme={theme}
              name={name}
              viewModeEnabled={!canWrite}
              autoFocus
              UIOptions={UI_OPTIONS}
            />
          </div>
        </Suspense>
      ) : null}
    </div>
  );
}

EditorSession.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onClose: PropTypes.func,
  onPresenceChange: PropTypes.func,
  onRegisterSave: PropTypes.func,
  onSaveStateChange: PropTypes.func,
  onRetry: PropTypes.func,
};
