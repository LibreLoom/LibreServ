import { useEffect, useId, useRef, useState } from "react";
import PropTypes from "prop-types";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import OfficeIssueCard from "./OfficeIssueCard.jsx";
import { useOptionalAuth } from "../../../context/AuthContext.jsx";
import { useTheme } from "@libreloom/ui/hooks/useTheme.jsx";
import { useFileSource } from "../../../lib/fileSource.jsx";
import { pathBasename } from "../../../lib/paths.js";
import {
  canSaveOfficeExt,
  createEuroOfficeSession,
  emitEuroOfficeSaved,
  EuroOfficeUnavailableError,
  requestEuroOfficeSaveLock,
  releaseEuroOfficeSaveLock,
  restoreEuroOfficeEditing,
  ensureOfficeBundle,
  euroOfficeDocumentType,
  watchEuroOfficeFocus,
  loadEuroOfficeDocsApi,
  patchEuroOfficeDownloadAs,
  patchEuroOfficeReconnect,
  patchEuroOfficeSaveState,
  saveEuroOfficeDocument,
  watchEuroOfficeChanges,
  watchEuroOfficeSaved,
  watchEuroOfficeSocket,
} from "./euroOfficeApi.js";
import { collabPresenceLabel } from "../collabPresence.js";
import { CollabSocket } from "./collabSocket.js";

const OPEN_TIMEOUT_MS = 60_000;
// Autosave is debounced: it fires once the user pauses for AUTOSAVE_IDLE_MS
// (serializing mid-keystroke would jank the editor), but never lets the doc
// stay stale past AUTOSAVE_MAX_MS during continuous typing. Failed saves
// retry after AUTOSAVE_RETRY_MS instead of hot-looping.
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MAX_MS = 15_000;
const AUTOSAVE_RETRY_MS = 5_000;
const AUTOSAVE_TICK_MS = 250;
// A save that never resolves (dead converter worker, stalled upload) must
// still release the save lock — otherwise autosave and the Save button
// stay wedged forever behind savingRef.
const SAVE_TIMEOUT_MS = 180_000;

/**
 * Absolute URL for a public Luna web asset (DocsAPI logo must be absolute).
 * @param {string} path
 */
function publicAssetUrl(path) {
  if (typeof window === "undefined") return path;
  const base = window.location.origin.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * EuroOffice DocsAPI host. The editor runs fully in this browser: x2t.wasm
 * converts the file to the editor's internal format, lunad stores the bundle
 * and relays co-editing between open tabs, and saving is the same path —
 * serialize live, convert back, upload. FileViewer owns the fullscreen
 * chrome; this component mounts the editor and reports presence upward.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onPresenceChange?: (label: string) => void,
 *   onSaveStateChange?: (hasUnsaved: boolean) => void,
 *   onRegisterSave?: (save: (() => Promise<unknown>) | null) => void,
 *   onUnavailable?: () => void,
 *   onClose?: () => void,
 * }} props
 */
export default function EuroOfficeHost({
  driveId,
  path,
  canWrite = false,
  onSaved,
  onPresenceChange,
  onSaveStateChange,
  onRegisterSave,
  onUnavailable,
  onClose,
}) {
  const mountId = useId().replace(/:/g, "");
  const placeholderId = `luna-eurooffice-${mountId}`;
  const mountRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const editorRef = useRef(/** @type {{ destroyEditor?: () => void } | null} */ (null));
  const dirtyRef = useRef(false);
  const dirtySinceRef = useRef(0);
  const lastEditRef = useRef(0);
  // Highest op index known to be persisted (our own save or a peer's
  // lunaSaved). Ops at or below it can't dirty the doc.
  const lastSavedIdxRef = useRef(/** @type {number | null} */ (null));
  // A peer's lunaSaved awaiting verification — `undefined` when none is
  // pending, `null` when the saver didn't report an index (clear at idle),
  // else the snapshot's op index.
  const peerSavedRef = useRef(/** @type {number | null | undefined} */ (undefined));
  const lastSaveAttemptRef = useRef(0);
  const savingRef = useRef(false);
  const saveFnRef = useRef(/** @type {(() => Promise<unknown>) | null} */ (null));
  const saveKeyHandlerRef = useRef(/** @type {((e: KeyboardEvent) => void) | null} */ (null));
  const saveKeyDocRef = useRef(/** @type {Document | null} */ (null));
  // Callbacks via refs so a parent passing an unstable function identity
  // can't tear the whole DocsAPI editor down and remount it — an inline
  // `onSaved`/`onSaveStateChange` previously re-ran the mount effect on
  // every parent render (including the listing refresh each save triggers).
  const onSavedRef = useRef(onSaved);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const onRegisterSaveRef = useRef(onRegisterSave);
  const onUnavailableRef = useRef(onUnavailable);
  onSavedRef.current = onSaved;
  onSaveStateChangeRef.current = onSaveStateChange;
  onRegisterSaveRef.current = onRegisterSave;
  onUnavailableRef.current = onUnavailable;
  // Bumped to force a full editor remount — the recovery path for the sdk's
  // coded "your document is stale" disconnects (it would otherwise park the
  // app in permanent view mode).
  const [reloadTick, setReloadTick] = useState(0);
  // Whether the current mount reached "ready" — a failure after that is a
  // crash while editing ("it opened fine, it broke"), not a failed open.
  const sawReadyRef = useRef(false);
  // Font-load failures (errorCode -26) are retried by remounting once — a
  // single dropped font fetch is otherwise fatal to a healthy editing
  // session. Bounded so a genuinely broken pack still surfaces the card.
  const fontRetryAtRef = useRef(0);
  const source = useFileSource();
  // Guests have no AuthProvider — and even when one is present (a signed-in
  // visitor previewing a link), the scoped session's identity is canonical.
  const auth = useOptionalAuth();
  const user = source.guest ? null : auth?.user;
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState(
    /** @type {"loading" | "error" | "ready"} */ ("loading"),
  );
  const [phase, setPhase] = useState("Starting EuroOffice…");
  const [error, setError] = useState("");
  const [peers, setPeers] = useState(/** @type {{ peer_id: number, username: string }[]} */ ([]));
  const [selfPeerId, setSelfPeerId] = useState(/** @type {number | null} */ (null));
  const name = pathBasename(path) || path;
  const uiTheme = resolvedTheme === "dark" ? "theme-dark" : "theme-light";

  useEffect(() => {
    // No room without a real file — an empty path 404s the upgrade, which
    // surfaces in the console as a failed connection. Guest sources have no
    // presence hub (the docstorage engine inside the editor still runs).
    if (!driveId || !path || source.collab === false) return;
    const sock = new CollabSocket(driveId, path);
    sock.onMessage = (msg) => {
      if (msg?.type === "welcome") {
        setPeers(Array.isArray(msg.peers) ? msg.peers : []);
        setSelfPeerId(typeof msg.peer_id === "number" ? msg.peer_id : null);
        return;
      }
      if (msg?.type === "peer_join" && msg.peer) {
        setPeers((prev) => {
          if (prev.some((p) => p.peer_id === msg.peer.peer_id)) return prev;
          return [...prev, msg.peer];
        });
        return;
      }
      if (msg?.type === "peer_leave") {
        setPeers((prev) => prev.filter((p) => p.peer_id !== msg.peer_id));
      }
    };
    sock.connect();
    return () => {
      sock.close();
    };
  }, [driveId, path, source]);

  const selfName = user?.display_name || user?.username || "";

  useEffect(() => {
    onPresenceChange?.(collabPresenceLabel(status, peers, canWrite, selfName, selfPeerId));
  }, [status, peers, canWrite, onPresenceChange, selfName, selfPeerId]);

  useEffect(() => {
    // No file, no session — an empty path must not mint one or fall into
    // the unsupported-type branch (its "cannot open" error is a lie here).
    if (!driveId || !path) return;
    let cancelled = false;
    let editor = /** @type {{ destroyEditor?: () => void } | null} */ (null);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let autosaveId;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let watchdogId;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let downloadPatchId;
    /** @type {(() => void) | undefined} */
    let unsubSaved;
    /** @type {(() => void) | undefined} */
    let unsubChanges;
    /** @type {(() => void) | undefined} */
    let unsubStale;
    /** @type {(() => void) | undefined} */
    let unsubFocus;

    // A coded drop (error/disconnectReason: restore 4010, updateVersion
    // 4008, noCache 4009) is the server telling the client its document
    // view is stale. The sdk parks those in permanent view mode because we
    // don't implement its in-place refreshFile — remounting against the
    // current bundle IS the refresh.
    let reloadRequested = false;
    const requestReload = () => {
      if (reloadRequested || cancelled) return;
      reloadRequested = true;
      setReloadTick((n) => n + 1);
    };

    (async () => {
      setStatus("loading");
      setPhase("Starting EuroOffice…");
      setError("");
      sawReadyRef.current = false;
      const docType = euroOfficeDocumentType(path);
      if (!docType) {
        setStatus("error");
        setError("EuroOffice cannot open this file type.");
        return;
      }
      try {
        const session = await createEuroOfficeSession(driveId, path, source);
        if (cancelled) return;
        // The pack check rides on this load: a missing pack 404s the script
        // or serves SPA HTML without window.DocsAPI, which loadEuroOfficeDocsApi
        // reports as EuroOfficeUnavailableError — the outer catch hands those
        // to the parent's install card instead of the error card.
        const DocsAPI = await loadEuroOfficeDocsApi();
        if (cancelled) return;

        const userName =
          user?.display_name ||
          user?.username ||
          session?.user?.name ||
          (canWrite ? "Editor" : "Viewer");
        const userId =
          user?.id != null
            ? String(user.id)
            : session?.user?.id != null
              ? String(session.user.id)
              : "luna-user";
        const write =
          typeof session?.can_write === "boolean" ? session.can_write && canWrite : canWrite;
        const ext = session.file_type || (name.split(".").pop() || "").toLowerCase();
        const canSave = write && canSaveOfficeExt(ext);
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

        // First opener converts the file to Editor.bin in this browser and
        // uploads the bundle; joiners find it already on Luna.
        setPhase("Opening with EuroOffice…");
        await ensureOfficeBundle(driveId, path, session, source);
        if (cancelled) return;

        timeoutId = setTimeout(() => {
          if (cancelled) return;
          setStatus((prev) => {
            if (prev !== "loading") return prev;
            setError("EuroOffice is taking too long to open. Close the file and try again.");
            return "error";
          });
        }, OPEN_TIMEOUT_MS);

        // Returns true only when the file was actually serialized and
        // uploaded — callers (Save button, save-and-close) must be able to
        // tell "nothing happened" from "saved" so failures never pass as
        // success.
        const doSave = async () => {
          if (savingRef.current) return false;
          savingRef.current = true;
          // DocsAPI replaceChild()s the placeholder with the iframe, so
          // it's a direct child of our mount — never inside the id'd div.
          const iframe = /** @type {HTMLIFrameElement | null} */ (
            mountRef.current?.querySelector('iframe[name="frameEditor"]') ?? null
          );
          const co = /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor
            ?.CoAuthoringApi?._CoAuthoringApi;
          let saveLocked = false;
          try {
            // Cross-client save exclusion over Luna's own election frame —
            // the sdk's isSaveLock/unSaveLock would park its connection in
            // AskSaveChanges for the whole serialize+upload, buffering every
            // askLock (i.e. freezing the saver's own typing), and an
            // unanswered unSaveLock wedges it for good. Denial means a peer
            // is mid-save: leave the doc dirty so the next autosave tick
            // retries.
            saveLocked = await requestEuroOfficeSaveLock(iframe);
            if (!saveLocked) return false;
            // The op index our live doc holds right now — the serialized
            // Editor.bin will contain every op up to this point. Sent with
            // the lunaSaved notice so peers can tell whether their own edits
            // made the snapshot (a peer holding newer ops stays dirty and
            // autosaves the tail itself).
            const snapshotIndex =
              typeof co?.changesIndex === "number" ? co.changesIndex : null;
            let timeout;
            const timedOut = new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Saving took too long. Try again.")),
                SAVE_TIMEOUT_MS,
              );
            });
            try {
              await Promise.race([
                saveEuroOfficeDocument(
                  iframe,
                  driveId,
                  session,
                  name,
                  folder,
                  snapshotIndex,
                  source,
                ),
                timedOut,
              ]);
            } finally {
              clearTimeout(timeout);
            }
            // Tell peers the live state is persisted — they clear their own
            // dirty flags and stand down their autosaves.
            emitEuroOfficeSaved(iframe, snapshotIndex);
            if (typeof snapshotIndex === "number") {
              lastSavedIdxRef.current = Math.max(
                lastSavedIdxRef.current ?? -1,
                snapshotIndex,
              );
            }
            peerSavedRef.current = undefined;
            dirtyRef.current = false;
            onSaveStateChangeRef.current?.(false);
            onSavedRef.current?.();
            return true;
          } finally {
            if (saveLocked) releaseEuroOfficeSaveLock(iframe);
            // A finished (or failed) save can leave the sdk's input disarmed
            // — parked save state, stale load mask, or a keyboard sink that
            // lost DOM focus. The stock app's only recovery for that is a
            // window blur→focus; run the equivalent here so editing just
            // keeps working.
            restoreEuroOfficeEditing(iframe);
            savingRef.current = false;
          }
        };
        saveFnRef.current = canSave ? doSave : null;
        // Drop watchdog — NOT gated on canSave: a view-mode editor that hits
        // a coded drop or exhausts reconnects is just as dead as an edit one.
        // A coded server drop (error/disconnectReason) marks
        // isCloseCoAuthoring and parks the app in view mode; a rebuild loop
        // that gave up sets __lunaConceded. Neither recovers in place — the
        // only cure is a remount against a fresh session + bundle.
        watchdogId = setInterval(() => {
          const wdCo = /** @type {any} */ (
            mountRef.current?.querySelector('iframe[name="frameEditor"]')
          )?.contentWindow?.Asc?.editor?.CoAuthoringApi?._CoAuthoringApi;
          if (wdCo?.isCloseCoAuthoring === true || wdCo?.__lunaConceded === true) {
            requestReload();
          }
        }, AUTOSAVE_TICK_MS);
        if (canSave) {
          // Autosave: same path as the Save button, on a dirty flag.
          autosaveId = setInterval(() => {
            const now = Date.now();
            // A peer's save may already cover our doc state — re-check
            // every tick instead of once at lunaSaved time, since foreign
            // ops keep bumping lastEditRef right up to the save and a
            // one-shot check there is almost always skipped (and dropped).
            if (dirtyRef.current && peerSavedRef.current !== undefined) {
              const savedIdx = peerSavedRef.current;
              const w = /** @type {any} */ (
                mountRef.current?.querySelector('iframe[name="frameEditor"]')
              )?.contentWindow;
              const collab = w?.AscCommon?.CollaborativeEditing;
              const coApi = w?.Asc?.editor?.CoAuthoringApi?._CoAuthoringApi;
              // GetAllChangesCount counts applied + pending ops on the
              // same axis as the server's changesIndex — the strictest
              // "everything I have is in the file" test available.
              const ourIndex =
                typeof collab?.GetAllChangesCount === "function"
                  ? collab.GetAllChangesCount()
                  : typeof coApi?.changesIndex === "number"
                    ? coApi.changesIndex
                    : null;
              const covered =
                savedIdx == null || (ourIndex != null && ourIndex <= savedIdx);
              if (covered && now - lastEditRef.current >= AUTOSAVE_IDLE_MS) {
                peerSavedRef.current = undefined;
                dirtyRef.current = false;
                dirtySinceRef.current = now;
                onSaveStateChangeRef.current?.(false);
                return;
              }
            }
            if (!dirtyRef.current || savingRef.current) return;
            if (now - lastSaveAttemptRef.current < AUTOSAVE_RETRY_MS) return;
            const idle = now - lastEditRef.current;
            const stale = now - dirtySinceRef.current;
            if (idle >= AUTOSAVE_IDLE_MS || stale >= AUTOSAVE_MAX_MS) {
              lastSaveAttemptRef.current = now;
              doSave().catch(() => {
                // keep editing; the tick retries after AUTOSAVE_RETRY_MS
              });
            }
          }, AUTOSAVE_TICK_MS);
        }

        // DocsAPI replaces the placeholder node with the editor iframe, so
        // the placeholder is created imperatively — never as a JSX child of
        // mountRef. Any React-owned child here breaks reconciliation when
        // the iframe replaces it (insertBefore on a stale node crashes the
        // whole page, not just the editor). Recreate it if a previous mount
        // (or dev StrictMode double-mount) consumed it.
        if (!document.getElementById(placeholderId) && mountRef.current) {
          const div = document.createElement("div");
          div.id = placeholderId;
          div.className = "h-full w-full";
          mountRef.current.appendChild(div);
        }
        editor = new DocsAPI.DocEditor(placeholderId, {
          width: "100%",
          height: "100%",
          type: "desktop",
          documentType: session.document_type || docType,
          document: {
            title: session.title || name,
            url: session.document_url,
            fileType: ext,
            key: session.key,
            permissions: {
              edit: Boolean(write),
              download: true,
              print: true,
              review: Boolean(write),
              comment: Boolean(write),
            },
          },
          // Flows into the docstorage handshake auth — lunad verifies it
          // against the drive+path the key was registered for.
          token: session.token,
          editorConfig: {
            // Editable only when Luna can actually write the format back —
            // letting a user edit an unsaveable format (e.g. legacy .doc)
            // silently loses their work, since the editor's own "changes
            // saved" caption only means "synced to the coauthoring session".
            mode: canSave ? "edit" : "view",
            lang: "en",
            canCoAuthoring: true,
            canBackToFolder: false,
            canCreateNew: false,
            // Must stay false: the app copies it into DocInfo
            // .SupportsOnSaveDocument, which routes every user save
            // (toolbar button, File → Save, Ctrl+S) through the Document
            // Server /downloadas endpoint we deliberately don't run —
            // that path ends in the "error while trying to work with the
            // document" toast. Real saves go through saveFnRef below.
            canSaveDocumentToBinary: false,
            user: { id: userId, name: userName },
            customization: {
              // help/feedback chrome is disabled and the logo is Luna's.
              // AGPL attribution is kept in luna/THIRD_PARTY_EUROOFFICE.md
              // rather than in the editor chrome.
              anonymous: { request: false },
              compactHeader: true,
              compactToolbar: false,
              feedback: false,
              // The in-editor Save command expects a Document Server
              // (/downloadas) we deliberately don't run — hide it and let
              // FileViewer's Save button + autosave do the real browser-side
              // save instead.
              forcesave: false,
              save: false,
              help: false,
              hideRightMenu: false,
              autosave: true,
              uiTheme,
              logo: {
                image: publicAssetUrl("/favicon.svg"),
                imageDark: publicAssetUrl("/favicon-dark.svg"),
                url: typeof window !== "undefined" ? window.location.origin : "",
              },
            },
          },
          events: {
            onAppReady: () => {
              sawReadyRef.current = true;
              if (!cancelled) setStatus("ready");
            },
            onDocumentReady: () => {
              sawReadyRef.current = true;
              if (!cancelled) setStatus("ready");
              // The iframe has navigated by now — hide the pack's statusbar
              // caption ("All changes saved"), which means "changes synced to
              // the collaboration server", not "file written to Luna storage".
              // The rail save button is our single source of truth.
              const hostIframe = /** @type {HTMLIFrameElement | null} */ (
                mountRef.current?.querySelector('iframe[name="frameEditor"]') ?? null
              );
              const hostDoc = hostIframe?.contentDocument;
              if (hostDoc && !hostDoc.getElementById("luna-hide-status-action")) {
                const style = hostDoc.createElement("style");
                style.id = "luna-hide-status-action";
                style.textContent = "#status-action,#label-action{visibility:hidden}";
                hostDoc.head.appendChild(style);
              }
              // The frame owns a focus watchdog: while it is the focused
              // browsing context and no real input inside owns DOM focus,
              // the keyboard sink holds it. Luna chrome clicks blur the
              // frame and the sdk never re-arms the sink on its own, so
              // typing stayed dead until a window blur→focus.
              unsubFocus?.();
              unsubFocus = watchEuroOfficeFocus(hostIframe);
              // Attach Ctrl+S interception to the live document (attaching
              // right after `new DocEditor` hits the pre-navigation document,
              // which the load throws away).
              if (canSave && !saveKeyDocRef.current && hostDoc) {
                saveKeyHandlerRef.current = (e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    saveFnRef.current?.().catch(() => {});
                  }
                };
                hostDoc.addEventListener("keydown", saveKeyHandlerRef.current, true);
                saveKeyDocRef.current = hostDoc;
              }
            },
            onDocumentStateChange: (event) => {
              if (event?.data === true) {
                const now = Date.now();
                if (!dirtyRef.current) dirtySinceRef.current = now;
                lastEditRef.current = now;
                dirtyRef.current = true;
                onSaveStateChangeRef.current?.(true);
              }
              // `false` (clean) is driven by our own save completion — the
              // editor's internal flag never clears on this save path.
            },
            onRequestRefreshFile: () => {
              // The sdk asks the host for a fresh document version after a
              // coded "stale" drop — without this callback it falls back to
              // setViewModeDisconnect and permanently flips the app to view
              // mode. Remounting against the current bundle is our refresh.
              requestReload();
            },
            onError: (event) => {
              // The sdk's data is often an object/code, not a string — log the
              // raw event so a real failure is diagnosable from the console.
              console.warn("EuroOffice onError", event);
              const code = event?.data?.errorCode;
              // -26 (LoadingFontError): the editor died because one font fetch
              // failed three times. A single dropped request shouldn't kill a
              // live session — remount once so a transient miss self-heals
              // (the service worker makes the retry cheap). If it fails again
              // within a minute the pack really is broken → show the card.
              if (code === -26 && Date.now() - fontRetryAtRef.current > 60_000) {
                fontRetryAtRef.current = Date.now();
                requestReload();
                return;
              }
              let message;
              if (code === -26) {
                message =
                  "The editor couldn't load a font it needs, so it stopped working. " +
                  "Reopen the file to try again — if it keeps failing, the " +
                  "EuroOffice fonts on this Luna are missing or out of date.";
              } else if (typeof event?.data === "string") {
                message = event.data;
              } else if (sawReadyRef.current) {
                message =
                  "The editor crashed while it was running. Reopen the file to keep going." +
                  (dirtyRef.current
                    ? " Your latest changes may not have saved — Luna autosaves every few seconds while you edit."
                    : "");
              } else {
                message =
                  "EuroOffice couldn't open this file. It may be damaged or in a format it can't read.";
              }
              if (!cancelled) {
                setError(message);
                setStatus("error");
              }
            },
          },
        });
        editorRef.current = editor;
        // Route the editor's File → Download menu through our browser-side
        // pipeline (the stock path needs a Document Server `downloadas`
        // endpoint that doesn't exist). Viewers may download too, so this is
        // not gated on canSave. Asc.editor can lag editor creation, so retry
        // until the patch lands.
        let patchTries = 0;
        const tryPatchDownload = () => {
          const iframe = /** @type {HTMLIFrameElement | null} */ (
            mountRef.current?.querySelector('iframe[name="frameEditor"]') ?? null
          );
          const api = /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor;
          if (!api) return false;
          patchEuroOfficeReconnect(iframe);
          patchEuroOfficeSaveState(iframe);
          patchEuroOfficeDownloadAs(iframe, name);
          // Peer save notices — a peer's completed save persisted the live
          // doc. Record the snapshot index and let the autosave tick clear
          // our dirty flag once our state is verifiably inside it; a
          // one-shot clear here would race the op stream (foreign ops bump
          // lastEditRef right up to the save) and get dropped, leaving the
          // flag stuck until our own save cycle.
          unsubSaved ??= watchEuroOfficeSaved(iframe, (data) => {
            const idx =
              typeof data?.changesIndex === "number" ? data.changesIndex : null;
            peerSavedRef.current = idx;
            if (idx != null && idx > (lastSavedIdxRef.current ?? -1)) {
              lastSavedIdxRef.current = idx;
            }
          });
          // Foreign op batches mean the shared document is ahead of the file
          // on disk — mark ourselves dirty so the save-state indicator stays
          // symmetric across clients (the editor's own document-state flag
          // only tracks local edits). Ops already inside a known-saved
          // snapshot (e.g. the saver's pending ops flushing after its own
          // lunaSaved) are persisted work, not new dirt. lastEdit bumps too:
          // autosave should wait for a pause in collaborative activity,
          // bounded by AUTOSAVE_MAX_MS.
          unsubChanges ??= watchEuroOfficeChanges(iframe, (data) => {
            const idx =
              typeof data?.changesIndex === "number" ? data.changesIndex : null;
            if (idx != null && lastSavedIdxRef.current != null && idx <= lastSavedIdxRef.current) {
              return;
            }
            const now = Date.now();
            if (!dirtyRef.current) dirtySinceRef.current = now;
            lastEditRef.current = now;
            dirtyRef.current = true;
            onSaveStateChangeRef.current?.(true);
          });
          // Coded server drops arrive as `error`/`drop` frames — the sdk
          // routes both to _onDrop → disconnect() → onDisconnect(code) →
          // setViewModeDisconnect, permanent view mode. lunad only emits
          // error:4010 today, but every drop frame means "your document view
          // is stale, reload" — remount on any of them rather than
          // enumerating codes.
          unsubStale ??= watchEuroOfficeSocket(iframe, (data) => {
            if (data?.type === "error" || data?.type === "drop") {
              requestReload();
            }
          });
          const co = api.CoAuthoringApi?._CoAuthoringApi;
          return (
            !!api.__lunaDownloadPatched &&
            co?.onDisconnect?.__lunaReconnect === true
          );
        };
        if (!tryPatchDownload()) {
          downloadPatchId = setInterval(() => {
            if (tryPatchDownload() || ++patchTries > 80) {
              clearInterval(downloadPatchId);
            }
          }, 250);
        }
        if (!cancelled && canSave) {
          // The thunk must always settle to a boolean — FileViewer treats
          // false as "didn't save" and keeps the doc dirty/open.
          onRegisterSaveRef.current?.(() => saveFnRef.current?.() ?? Promise.resolve(false));
        }
      } catch (err) {
        if (cancelled) return;
        // Pack missing or incomplete (DocsAPI or the x2t converter) — the
        // parent swaps in its install card rather than an error notice.
        if (err instanceof EuroOfficeUnavailableError && onUnavailableRef.current) {
          onUnavailableRef.current();
          return;
        }
        setStatus("error");
        setError(
          err instanceof Error
            ? err.message
            : "EuroOffice could not start. Check that the EuroOffice pack on this Luna is complete.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (autosaveId) clearInterval(autosaveId);
      if (watchdogId) clearInterval(watchdogId);
      if (downloadPatchId) clearInterval(downloadPatchId);
      unsubSaved?.();
      unsubChanges?.();
      unsubStale?.();
      unsubFocus?.();
      try {
        editor?.destroyEditor?.();
      } catch {
        // ignore destroy races
      }
      editorRef.current = null;
      saveFnRef.current = null;
      if (saveKeyDocRef.current && saveKeyHandlerRef.current) {
        saveKeyDocRef.current.removeEventListener("keydown", saveKeyHandlerRef.current, true);
      }
      saveKeyDocRef.current = null;
      saveKeyHandlerRef.current = null;
      onRegisterSaveRef.current?.(null);
      const node = document.getElementById(placeholderId);
      if (node) node.replaceChildren();
    };
    // Callback props are deliberately NOT deps — they're read through refs
    // so an unstable caller identity can't remount the editor. reloadTick
    // is the explicit remount signal.
  }, [
    driveId,
    path,
    canWrite,
    name,
    placeholderId,
    user,
    uiTheme,
    source,
    reloadTick,
  ]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary text-secondary">
      {status === "error" ? (
        /* A failed open gets a real card, not a raw converter message over
           a void — name the file, say what happened in plain language, and
           offer the things a person can actually do next. A crash after a
           successful open reads differently from a file that never opened. */
        <OfficeIssueCard
          title={
            sawReadyRef.current ? `${name} stopped working` : `Couldn't open ${name}`
          }
          downloadUrl={source.downloadHref(driveId, path)}
          downloadName={name}
          onClose={onClose}
          onRetry={() => {
            setError("");
            setStatus("loading");
            setReloadTick((n) => n + 1);
          }}
        >
          {error ||
            "EuroOffice couldn't open this file. It may be damaged or in a format it can't read."}
        </OfficeIssueCard>
      ) : (
        /* mountRef must own zero React children: DocsAPI replaceChild()s the
           placeholder with the editor iframe, so anything React tracks inside
           it reconciles against a mutated DOM and can crash the page (the
           insertBefore-on-stale-node error). The placeholder div is created
           imperatively in the effect instead. */
        <div className="relative min-h-0 flex-1">
          {status === "loading" ? (
            <div className="absolute inset-0 z-[1] flex items-center justify-center bg-primary">
              <div className="flex items-center gap-3 text-secondary">
                <p className="font-mono text-sm">{phase}</p>
                <Spinner size="md" decorative />
              </div>
            </div>
          ) : null}
          <div ref={mountRef} className="h-full w-full" />
        </div>
      )}
    </div>
  );
}

EuroOfficeHost.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onPresenceChange: PropTypes.func,
  onSaveStateChange: PropTypes.func,
  onRegisterSave: PropTypes.func,
  onUnavailable: PropTypes.func,
  onClose: PropTypes.func,
};
