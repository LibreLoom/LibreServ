import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ModalCard, {
  NESTED_OVERLAY_CLASS,
} from "@libreloom/ui/components/cards/ModalCard.jsx";
import OfficeIssueCard from "../office/OfficeIssueCard.jsx";
import { useTheme } from "@libreloom/ui/hooks/useTheme.jsx";
import { apiErrorMessage } from "../../../lib/api.js";
import { pathBasename } from "../../../lib/paths.js";
import { useFileSource } from "../../../lib/fileSource.jsx";
import {
  DIAGRAM_EXPORT_FORMAT,
  DIAGRAM_MIME,
  diagramContainer,
} from "../../../lib/diagramFile.js";
import {
  diagramBytesFromExport,
  diagramLoadXml,
  downloadDiagramCopy,
  drawioEmbedUrl,
  parseEmbedMessage,
  postToEditor,
  probeDrawioPack,
} from "./drawioApi.js";
import DiagramLockedCard from "./DiagramLockedCard.jsx";
import { useDiagramLock } from "./useDiagramLock.js";
import { ApiError } from "../../../lib/api.js";

// Autosave mirrors TextFileEditor: fire once editing pauses for
// AUTOSAVE_IDLE_MS, never let unsaved work age past AUTOSAVE_MAX_MS during
// continuous editing, and back off AUTOSAVE_RETRY_MS after a failed save.
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MAX_MS = 15_000;
const AUTOSAVE_RETRY_MS = 5_000;
const AUTOSAVE_TICK_MS = 250;
// The init handshake or an export reply that never arrives must not wedge
// the session — surface an open error / let the next save retry instead.
const OPEN_TIMEOUT_MS = 60_000;
const EXPORT_TIMEOUT_MS = 60_000;

/**
 * Fullscreen diagrams.net editor — mounts inside FileViewer's
 * FullscreenEditorFrame and plugs into its save contract (register a save
 * thunk once the editor is loaded, report dirty state so the guard modal,
 * Save button, and beforeunload all work).
 *
 * Pack discovery mirrors the office pack: probe the marker file, then let a
 * missing or half-installed pack land on its own install card instead of
 * reading as "the file is broken".
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onClose?: () => void,
 *   onRegisterSave?: (save: (() => Promise<unknown>) | null) => void,
 *   onSaveStateChange?: (hasUnsaved: boolean) => void,
 *   requestClose?: () => void,
 * }} props
 */
export default function DiagramEditor(props) {
  return <EditorSession key={`${props.driveId}:${props.path}`} {...props} />;
}

DiagramEditor.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onClose: PropTypes.func,
  onRegisterSave: PropTypes.func,
  onSaveStateChange: PropTypes.func,
  requestClose: PropTypes.func,
};

/**
 * @param {Parameters<typeof DiagramEditor>[0]} props
 */
function EditorSession({
  driveId,
  path,
  canWrite = false,
  onSaved,
  onClose,
  onRegisterSave,
  onSaveStateChange,
  requestClose,
}) {
  const name = pathBasename(path) || path;
  const container = diagramContainer(name);
  const source = useFileSource();
  const { resolvedTheme } = useTheme();
  const [phase, setPhase] = useState(
    /** @type {"loading" | "ready" | "missing" | "error" | "locked"} */ ("loading"),
  );
  const [error, setError] = useState("");
  const [retryTick, setRetryTick] = useState(0);
  // "Open read-only" from the locked card — same session, just no lock and
  // a noSaveBtn embed. Deliberately outside the render-phase reset: a retry
  // after an open error shouldn't silently flip the file back to writable.
  const [readOnly, setReadOnly] = useState(false);
  const effectiveCanWrite = canWrite && !readOnly;
  // HACK: advisory edit lock (useDiagramLock.js) — stopgap until real
  // diagram collab. Acquire happens in the load effect below; the hold
  // socket and release are the hook's job.
  const lock = useDiagramLock({ driveId, path });
  const acquireLock = lock.acquire; // stable on [driveId, path]
  const lockLostRef = useRef(false);
  lockLostRef.current = lock.status === "lost";
  // The lock-lost modal shows once per loss — "Keep editing" dismisses it
  // and later saves keep downloading copies.
  const [lostAcked, setLostAcked] = useState(false);
  const [copyError, setCopyError] = useState("");
  // Regaining the hold (reconnect/re-acquire) re-arms the modal so a real
  // later loss isn't swallowed by an old dismissal.
  const [prevLockStatus, setPrevLockStatus] = useState(lock.status);
  if (prevLockStatus !== lock.status) {
    setPrevLockStatus(lock.status);
    if (lock.status === "held") {
      setLostAcked(false);
      setCopyError("");
    }
  }
  // True once the editor confirmed the document `load` — gates the save
  // thunk registration so Save stays disabled until a session is up.
  const [docLoaded, setDocLoaded] = useState(false);
  const iframeRef = useRef(/** @type {HTMLIFrameElement | null} */ (null));
  // The iframe whose document already carries the activity listeners.
  const iframeWatchedRef = useRef(/** @type {HTMLIFrameElement | null} */ (null));
  // The diagram payload (xml text or data URI) fetched from the drive,
  // handed to the editor on `init`.
  const payloadRef = useRef(/** @type {string | null} */ (null));
  const dirtyRef = useRef(false);
  const dirtySinceRef = useRef(0);
  const lastEditRef = useRef(0);
  const lastSaveAttemptRef = useRef(0);
  const savingRef = useRef(false);
  // One pending export at a time — the save thunk awaits the editor's reply.
  const pendingExportRef = useRef(
    /** @type {{ resolve: (m: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */ (null),
  );
  const iframeAliveRef = useRef(false);
  // Callbacks via refs so an unstable parent identity can't tear the embed
  // down mid-session (same reasoning as EuroOfficeHost).
  const onSavedRef = useRef(onSaved);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const requestCloseRef = useRef(requestClose);
  const onCloseRef = useRef(onClose);
  onSavedRef.current = onSaved;
  onSaveStateChangeRef.current = onSaveStateChange;
  requestCloseRef.current = requestClose;
  onCloseRef.current = onClose;

  // Render-phase reset (same pattern as FileViewer's previewKey scope): a
  // retry or a new file drops back to the probe+load phase without a
  // setState inside the effect body.
  const sessionScope = `${driveId}:${path}:${container}:${retryTick}`;
  const [scope, setScope] = useState(sessionScope);
  if (scope !== sessionScope) {
    setScope(sessionScope);
    setPhase("loading");
    setError("");
    setDocLoaded(false);
    iframeAliveRef.current = false;
    payloadRef.current = null;
    dirtyRef.current = false;
    setLostAcked(false);
    setCopyError("");
  }

  // Probe the pack, then fetch the file. "Missing pack" is its own phase —
  // it gets the install card, not the open-error card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pack = await probeDrawioPack();
      if (cancelled) return;
      if (pack === "missing") {
        setPhase("missing");
        return;
      }
      if (pack === "unreachable") {
        setPhase("error");
        setError("Couldn't reach Luna. Check this device's connection and try again.");
        return;
      }
      // HACK (advisory lock): writable opens must hold the lock before the
      // editor mounts. "blocked" gets the who-is-editing card; "failed"
      // (endpoint gone, network down) degrades to editing without a lock —
      // an advisory stopgap must never gate editing.
      if (effectiveCanWrite) {
        const res = await acquireLock();
        if (cancelled) return;
        if (res === "blocked") {
          setPhase("locked");
          return;
        }
      }
      try {
        const res = await source.fetch(source.contentHref(driveId, path));
        if (!res.ok) throw new Error("Luna couldn't open this file.");
        if (container === "xml") {
          payloadRef.current = diagramLoadXml(await res.text(), null, "xml");
        } else {
          payloadRef.current = diagramLoadXml(
            "",
            await res.arrayBuffer(),
            container,
          );
        }
        if (!cancelled) setPhase("ready");
      } catch (err) {
        if (!cancelled) {
          setPhase("error");
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, driveId, path, container, retryTick, effectiveCanWrite, acquireLock]);

  /**
   * Ask the editor for the current file bytes in this file's container
   * format. Resolves with the editor's `export` event payload.
   * @returns {Promise<any>}
   */
  const requestExport = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !iframeAliveRef.current) {
      return Promise.reject(
        new Error("The diagram editor isn't ready yet. Try again in a moment."),
      );
    }
    if (pendingExportRef.current) {
      return Promise.reject(
        new Error("A save is already in progress. Try again in a moment."),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExportRef.current = null;
        reject(new Error("Saving took too long. Try again."));
      }, EXPORT_TIMEOUT_MS);
      pendingExportRef.current = { resolve, reject, timer };
      postToEditor(iframe, {
        action: "export",
        format: DIAGRAM_EXPORT_FORMAT[container],
        spinKey: "saving",
      });
    });
  }, [container]);

  const lockMarkLostRef = useRef(lock.markLost);
  lockMarkLostRef.current = lock.markLost;
  const lockSaveHeadersRef = useRef(lock.saveHeaders);
  lockSaveHeadersRef.current = lock.saveHeaders;
  // Idle reporting (advisory lock): any editor message or input inside the
  // same-origin iframe counts as activity.
  const noteActivityRef = useRef(lock.noteActivity);
  noteActivityRef.current = lock.noteActivity;

  /**
   * Serialize + upload through the normal files write path — the same
   * overwrite upload the text editor uses. Returns true only when the file
   * actually landed, so the frame never reports a save that didn't happen.
   */
  const save = useCallback(async () => {
    if (savingRef.current) return false;
    savingRef.current = true;
    const iframe = iframeRef.current;
    try {
      const exportMsg = await requestExport();
      const bytes = diagramBytesFromExport(container, exportMsg);
      // HACK (advisory lock): the lock was lost mid-edit — the drive copy
      // may belong to someone else's session now, so save downloads a
      // `*-copy` file instead of overwriting.
      if (lockLostRef.current) {
        downloadDiagramCopy(name, bytes, DIAGRAM_MIME[container]);
        dirtyRef.current = false;
        onSaveStateChangeRef.current?.(false);
        onSavedRef.current?.();
        return true;
      }
      const blob = new Blob(
        [/** @type {BlobPart} */ (bytes)],
        { type: DIAGRAM_MIME[container] },
      );
      try {
        // Guests prove lock ownership with the session id; members are
        // identified by their session cookie and send nothing extra.
        await source.saveFile(driveId, path, name, blob, {
          headers: lockSaveHeadersRef.current(),
        });
      } catch (err) {
        // Write-path enforcement: a 409 means the lock belongs to someone
        // else — flip to the save-a-copy modal, then let the frame's
        // save-error surface report the failed save.
        if (
          err instanceof ApiError &&
          err.status === 409 &&
          err.code === "diagram_locked"
        ) {
          // The 409 body names the holder when there is one.
          lockMarkLostRef.current(
            typeof err.data?.holder === "string" ? err.data.holder : undefined,
          );
        }
        throw err;
      }
      // Clear the editor's own modified flag — its status bar tracks dirty
      // state separately from the frame's.
      postToEditor(iframe, { action: "status", message: "", modified: false });
      dirtyRef.current = false;
      onSaveStateChangeRef.current?.(false);
      onSavedRef.current?.();
      return true;
    } finally {
      savingRef.current = false;
    }
  }, [container, driveId, name, path, requestExport, source]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Autosave tick — same cadence contract as TextFileEditor.
  useEffect(() => {
    if (phase !== "ready" || !effectiveCanWrite) return undefined;
    const id = setInterval(() => {
      const now = Date.now();
      if (!dirtyRef.current) {
        dirtySinceRef.current = 0;
        return;
      }
      if (!dirtySinceRef.current) dirtySinceRef.current = now;
      if (savingRef.current) return;
      // Lock lost → save() would download a copy each tick; leave the
      // modal's manual "Save a copy" as the only copy trigger.
      if (lockLostRef.current) return;
      if (now - lastSaveAttemptRef.current < AUTOSAVE_RETRY_MS) return;
      const idle = now - lastEditRef.current;
      const stale = now - dirtySinceRef.current;
      if (idle >= AUTOSAVE_IDLE_MS || stale >= AUTOSAVE_MAX_MS) {
        lastSaveAttemptRef.current = now;
        saveRef.current().catch(() => {
          // keep editing; the tick retries after AUTOSAVE_RETRY_MS
        });
      }
    }, AUTOSAVE_TICK_MS);
    return () => clearInterval(id);
  }, [phase, effectiveCanWrite]);

  // Register the save thunk once the editor has loaded the document.
  // Still registered when the lock is lost — save() then exports a copy
  // to downloads instead of overwriting.
  useEffect(() => {
    if (!docLoaded || !effectiveCanWrite || !onRegisterSave) return undefined;
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [docLoaded, effectiveCanWrite, save, onRegisterSave]);

  // Embed protocol: init → load → autosave/save/exit/export. The listener
  // attaches once the iframe exists (phase "ready").
  useEffect(() => {
    if (phase !== "ready") return undefined;
    const iframe = iframeRef.current;
    if (!iframe) return undefined;

    const openTimeout = setTimeout(() => {
      if (!iframeAliveRef.current) {
        setPhase("error");
        setError(
          "The diagram editor is taking too long to open. Close the file and try again.",
        );
      }
    }, OPEN_TIMEOUT_MS);

    /** @param {MessageEvent} event */
    function onMessage(event) {
      // Only messages from our iframe; same-origin, so origin must match too.
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const msg = parseEmbedMessage(event.data);
      if (!msg || !msg.event) return;
      noteActivityRef.current?.();

      switch (msg.event) {
        case "configure":
          // Not requested via configure=1, but answer defensively so the
          // editor can't stall waiting for it.
          postToEditor(iframe, { action: "configure", config: {} });
          break;
        case "init":
          iframeAliveRef.current = true;
          // The pack is same-origin — watch real input inside the editor
          // (mousemove over a drawing) so idle means idle, not "typing in
          // the iframe the parent can't see".
          if (iframeWatchedRef.current !== iframe) {
            iframeWatchedRef.current = iframe;
            try {
              const doc = iframe.contentDocument;
              for (const ev of [
                "pointermove",
                "pointerdown",
                "keydown",
                "wheel",
                "touchstart",
              ]) {
                doc?.addEventListener(ev, () => noteActivityRef.current?.(), {
                  passive: true,
                });
              }
            } catch {
              // Same-origin in practice; if it ever isn't, embed messages
              // still count as activity.
            }
          }
          postToEditor(iframe, {
            action: "load",
            xml: payloadRef.current,
            autosave: 1,
            title: name,
            // Resource key: the editor's own status bar reads
            // "Unsaved changes" while modified.
            modified: "unsavedChanges",
          });
          break;
        case "load":
          setDocLoaded(true);
          break;
        case "autosave":
          // The autosave payload carries xml, but every container goes
          // through export on save anyway — the event is just the dirty
          // signal.
          lastEditRef.current = Date.now();
          if (!dirtyRef.current) {
            dirtyRef.current = true;
            onSaveStateChangeRef.current?.(true);
          }
          break;
        case "save":
          lastEditRef.current = Date.now();
          dirtyRef.current = true;
          onSaveStateChangeRef.current?.(true);
          if (effectiveCanWrite) {
            const exitAfter = msg.exit === true;
            saveRef.current()
              .then((saved) => {
                if (saved && exitAfter) onCloseRef.current?.();
              })
              .catch(() => {
                // The frame's save error surface covers manual saves; the
                // autosave tick retries editor-initiated ones.
              });
          }
          break;
        case "export":
          if (pendingExportRef.current) {
            const pending = pendingExportRef.current;
            pendingExportRef.current = null;
            clearTimeout(pending.timer);
            if (msg.error || msg.message === "emptySelection") {
              pending.reject(
                new Error("The diagram editor couldn't build the file. Try again."),
              );
            } else {
              pending.resolve(msg);
            }
          }
          break;
        case "exit":
          // noExitBtn hides the editor's Exit button; template-cancel and a
          // few other paths can still emit it — funnel through the frame's
          // guarded close.
          requestCloseRef.current?.();
          break;
        default:
          break;
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      clearTimeout(openTimeout);
      window.removeEventListener("message", onMessage);
      iframeAliveRef.current = false;
      if (pendingExportRef.current) {
        clearTimeout(pendingExportRef.current.timer);
        pendingExportRef.current.reject(new Error("The editor was closed."));
        pendingExportRef.current = null;
      }
    };
  }, [phase, effectiveCanWrite, name]);

  // HACK (advisory lock): someone else holds the edit lock.
  if (phase === "locked") {
    return (
      <DiagramLockedCard
        holderName={lock.holder}
        selfHold={lock.selfHold}
        downloadUrl={source.downloadHref(driveId, path)}
        downloadName={name}
        onOpenReadOnly={() => setReadOnly(true)}
        onClose={onClose}
      />
    );
  }

  if (phase === "missing") {
    return (
      <OfficeIssueCard
        title="This Luna can't open diagrams"
        downloadUrl={source.downloadHref(driveId, path)}
        downloadName={name}
        onClose={onClose}
      >
        <p>
          Your file is fine — this Luna just doesn't have its diagram editor.
          Download it to keep working in another app.
        </p>
        <PageNotice variant="info" surface="secondary" className="mt-3">
          Technical details: Luna's <span className="font-mono">draw.io</span>{" "}
          pack is missing or incomplete. It lives in the{" "}
          <span className="font-mono">drawio</span> folder inside Luna's data
          directory (<span className="font-mono">/var/lib/luna/drawio</span>{" "}
          on installed devices). Add the pack and restart Luna.
        </PageNotice>
      </OfficeIssueCard>
    );
  }

  if (phase === "error") {
    return (
      <OfficeIssueCard
        title="Luna couldn't open this diagram"
        downloadUrl={source.downloadHref(driveId, path)}
        downloadName={name}
        onClose={onClose}
        onRetry={() => setRetryTick((n) => n + 1)}
      >
        <PageNotice variant="error">{error}</PageNotice>
      </OfficeIssueCard>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {phase === "loading" ? (
        <div
          className="flex h-full items-center justify-center"
          role="status"
          aria-label={`Opening ${name}`}
        >
          <div className="flex items-center gap-3 text-secondary">
            <p className="font-mono text-sm uppercase tracking-widest">
              Opening
            </p>
            <Spinner size="md" decorative />
          </div>
        </div>
      ) : (
        <>
          {/* HACK (advisory lock): losing the hold mid-edit interrupts once
              with a modal — never a banner that can spawn repeatedly. */}
          <ModalCard
            open={lock.status === "lost" && !lostAcked}
            onClose={() => setLostAcked(true)}
            title="Editing session ended"
            showCloseButton={false}
            overlayClassName={NESTED_OVERLAY_CLASS}
            openHaptic="warning"
          >
            {({ close }) => (
              <div className="space-y-4">
                <p className="text-sm text-primary">
                  {lock.holder
                    ? `${lock.holder} is editing this diagram now, so saving to it is turned off for this session.`
                    : "This diagram's editing session ended — someone else may be editing it now, so saving to it is turned off for this session."}{" "}
                  Save to download your changes instead.
                </p>
                {copyError ? (
                  <PageNotice variant="error" surface="secondary">
                    {copyError}
                  </PageNotice>
                ) : null}
                <div className="flex flex-col gap-3">
                  <Button
                    variant="primary"
                    surface="secondary"
                    fullWidth
                    haptic="light"
                    onClick={() => {
                      setCopyError("");
                      void saveRef
                        .current()
                        .then((ok) => {
                          if (ok) {
                            setLostAcked(true);
                            close();
                          } else {
                            setCopyError(
                              "Luna couldn't download your changes. Try again.",
                            );
                          }
                        })
                        .catch(() =>
                          setCopyError(
                            "Luna couldn't download your changes. Try again.",
                          ),
                        );
                    }}
                  >
                    Download my changes
                  </Button>
                  <Button
                    variant="outline"
                    surface="secondary"
                    fullWidth
                    haptic="light"
                    onClick={() => {
                      setLostAcked(true);
                      close();
                    }}
                  >
                    Keep editing — saves become downloads
                  </Button>
                </div>
              </div>
            )}
          </ModalCard>
          <iframe
            ref={iframeRef}
            src={drawioEmbedUrl({ dark: resolvedTheme === "dark", canWrite: effectiveCanWrite })}
          title={`Diagram editor — ${name}`}
          className="h-full min-h-0 w-full flex-1 border-0 bg-primary text-secondary"
            // The pack is same-origin and self-hosted; sandbox still fences
            // it off from Luna's own app surface.
            sandbox="allow-scripts allow-same-origin allow-modals allow-popups allow-downloads allow-forms"
            allow="clipboard-read; clipboard-write"
          />
        </>
      )}
    </div>
  );
}

EditorSession.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onClose: PropTypes.func,
  onRegisterSave: PropTypes.func,
  onSaveStateChange: PropTypes.func,
  requestClose: PropTypes.func,
};
