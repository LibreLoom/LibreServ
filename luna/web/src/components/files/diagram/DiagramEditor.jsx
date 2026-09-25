import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { useTheme } from "@libreloom/ui/hooks/useTheme.jsx";
import { apiErrorMessage } from "../../../lib/api.js";
import { pathBasename } from "../../../lib/paths.js";
import { useFileSource } from "../../../lib/fileSource.jsx";
import { useOptionalAuth } from "../../../context/AuthContext.jsx";
import {
  DIAGRAM_EXPORT_FORMAT,
  DIAGRAM_MIME,
  diagramContainer,
} from "../../../lib/diagramFile.js";
import OfficeIssueCard from "../office/OfficeIssueCard.jsx";
import { collabPresenceLabel } from "../collabPresence.js";
import {
  diagramBytesFromExport,
  diagramLoadXml,
  drawioEmbedUrl,
  parseEmbedMessage,
  postToEditor,
  probeDrawioPack,
} from "./drawioApi.js";
import { DiagramCollab } from "./diagramCollab.js";

// Autosave mirrors TextFileEditor and EuroOffice: fire once editing pauses
// for AUTOSAVE_IDLE_MS, never let unsaved work age past AUTOSAVE_MAX_MS
// during continuous editing, and back off AUTOSAVE_RETRY_MS after a failed
// save. A denied save election counts as a failed attempt — the next tick
// retries once the other person has finished uploading.
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MAX_MS = 15_000;
const AUTOSAVE_RETRY_MS = 5_000;
const AUTOSAVE_TICK_MS = 250;
const OPEN_TIMEOUT_MS = 60_000;
const EXPORT_TIMEOUT_MS = 60_000;
const PATCH_TIMEOUT_MS = 15_000;
/** Failed applies are retried. After this many, the seq stays outstanding. */
const PATCH_ATTEMPTS = 3;

/**
 * Fullscreen diagrams.net editor — mounts inside FileViewer's
 * FullscreenEditorFrame and plugs into its save contract.
 *
 * Live edits use the same collab room as EuroOffice. Draw.io emits a diff
 * patch on each change (`diffSync`); Luna relays that patch as an opaque
 * op. Other open editors apply it in place, so two people can work in the
 * same diagram. Saving still writes the file through the normal upload
 * path, with one editor uploading at a time.
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
  onPresenceChange: PropTypes.func,
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
  onPresenceChange,
  onRegisterSave,
  onSaveStateChange,
  requestClose,
}) {
  const name = pathBasename(path) || path;
  const container = diagramContainer(name);
  const source = useFileSource();
  const auth = useOptionalAuth();
  const user = source.guest ? null : auth?.user;
  const selfName = user?.display_name || user?.username || "";
  const { resolvedTheme } = useTheme();
  const [phase, setPhase] = useState(
    /** @type {"loading" | "ready" | "missing" | "error"} */ ("loading"),
  );
  const [error, setError] = useState("");
  const [retryTick, setRetryTick] = useState(0);
  const [peers, setPeers] = useState(/** @type {{ peer_id: number, username: string }[]} */ ([]));
  const [selfPeerId, setSelfPeerId] = useState(/** @type {number | null} */ (null));
  const [docLoaded, setDocLoaded] = useState(false);
  const iframeRef = useRef(/** @type {HTMLIFrameElement | null} */ (null));
  const payloadRef = useRef(/** @type {string | null} */ (null));
  const dirtyRef = useRef(false);
  const dirtySinceRef = useRef(0);
  /** Seq from the latest peer save, or null when that save named none. */
  const peerSavedSeqRef = useRef(/** @type {number | null | undefined} */ (undefined));
  const lastEditRef = useRef(0);
  const lastSaveAttemptRef = useRef(0);
  const savingRef = useRef(false);
  /** Set only around the export, so a patch cannot land in the file after coverage was taken. */
  const exportingRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const pendingExportRef = useRef(
    /** @type {{ resolve: (m: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */ (null),
  );
  const pendingPatchRef = useRef(
    /** @type {{ seq: number | undefined, resolve: () => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> } | null} */ (null),
  );
  /** @type {import("react").MutableRefObject<{ seq?: number, patch: unknown, checksum?: unknown, attempts?: number }[]>} */
  const patchQueueRef = useRef([]);
  const pumpingRef = useRef(false);
  const iframeAliveRef = useRef(false);
  const docLoadedRef = useRef(false);
  const collabRef = useRef(/** @type {DiagramCollab | null} */ (null));
  const onSavedRef = useRef(onSaved);
  const onSaveStateChangeRef = useRef(onSaveStateChange);
  const onPresenceChangeRef = useRef(onPresenceChange);
  const requestCloseRef = useRef(requestClose);
  const onCloseRef = useRef(onClose);
  onSavedRef.current = onSaved;
  onSaveStateChangeRef.current = onSaveStateChange;
  onPresenceChangeRef.current = onPresenceChange;
  requestCloseRef.current = requestClose;
  onCloseRef.current = onClose;

  const sessionScope = `${driveId}:${path}:${container}:${retryTick}`;
  const [scope, setScope] = useState(sessionScope);
  if (scope !== sessionScope) {
    setScope(sessionScope);
    setPhase("loading");
    setError("");
    setDocLoaded(false);
    setPeers([]);
    setSelfPeerId(null);
    iframeAliveRef.current = false;
    docLoadedRef.current = false;
    payloadRef.current = null;
    dirtyRef.current = false;
    peerSavedSeqRef.current = undefined;
    patchQueueRef.current = [];
    exportingRef.current = false;
  }

  const reportDirty = useCallback((dirty) => {
    dirtyRef.current = dirty;
    if (dirty && !dirtySinceRef.current) dirtySinceRef.current = Date.now();
    onSaveStateChangeRef.current?.(dirty);
  }, []);

  const presenceStatus =
    phase === "ready" ? "ready" : phase === "error" || phase === "missing" ? "error" : "loading";

  useEffect(() => {
    onPresenceChangeRef.current?.(
      collabPresenceLabel(
        presenceStatus,
        peers,
        canWrite,
        selfName,
        selfPeerId,
        "Opening this diagram…",
      ),
    );
  }, [presenceStatus, peers, canWrite, selfName, selfPeerId]);

  const pumpPatchesRef = useRef(() => {});

  const pumpPatches = useCallback(() => {
    // Coverage is already taken. A patch applied now would be in the file
    // and missing from the sequence the upload is about to name.
    if (exportingRef.current) return;
    if (pumpingRef.current || pendingPatchRef.current) return;
    if (!docLoadedRef.current || !iframeAliveRef.current) return;
    const next = patchQueueRef.current.shift();
    if (!next) return;
    const iframe = iframeRef.current;
    if (!iframe) {
      patchQueueRef.current.unshift(next);
      return;
    }
    pumpingRef.current = true;
    applyingRemoteRef.current = true;

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const finish = () => {
      clearTimeout(timer);
      pendingPatchRef.current = null;
      pumpingRef.current = false;
      applyingRemoteRef.current = false;
    };
    // A dropped apply must come back. Giving up leaves the seq outstanding
    // in DiagramCollab, so a save cannot compact a patch the file lacks.
    const retry = () => {
      finish();
      const attempts = (next.attempts || 0) + 1;
      if (attempts < PATCH_ATTEMPTS) {
        patchQueueRef.current.unshift({ ...next, attempts });
      }
      pumpPatchesRef.current();
    };

    timer = setTimeout(retry, PATCH_TIMEOUT_MS);
    pendingPatchRef.current = {
      seq: next.seq,
      resolve: () => {
        finish();
        collabRef.current?.confirmApplied(next.seq);
        if (canWrite) {
          lastEditRef.current = Date.now();
          reportDirty(true);
        }
        pumpPatchesRef.current();
      },
      reject: retry,
      timer,
    };
    postToEditor(iframe, { action: "patch", patch: next.patch });
  }, [canWrite, reportDirty]);
  pumpPatchesRef.current = pumpPatches;

  // Probe the pack, fetch the file, then join the collab room. The file
  // fetch runs first so a password-protected share can mint its proof
  // cookie before the WebSocket upgrade (browsers cannot set headers on
  // the socket).
  useEffect(() => {
    let cancelled = false;
    /** @type {DiagramCollab | null} */
    let collab = null;
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
      } catch (err) {
        if (!cancelled) {
          setPhase("error");
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
        }
        return;
      }
      if (cancelled) return;
      const url = source.collabWsUrl?.(driveId, path);
      if (url) {
        collab = new DiagramCollab({
          driveId,
          path,
          url,
          canWrite,
          onUpdate: (snap) => {
            if (cancelled) return;
            setPeers(snap.peers);
            setSelfPeerId(snap.selfPeerId);
          },
          onRemotePatch: (patch) => {
            const seq = patch?.seq;
            if (typeof seq === "number") {
              if (pendingPatchRef.current?.seq === seq) return;
              if (patchQueueRef.current.some((queued) => queued.seq === seq)) return;
            }
            patchQueueRef.current.push({ ...patch, attempts: 0 });
            pumpPatchesRef.current();
          },
          onPeerSaved: (msg) => {
            // Rechecked on the autosave tick, once editing has paused —
            // the same moment EuroOffice compares changesIndex.
            peerSavedSeqRef.current = typeof msg?.seq === "number" ? msg.seq : null;
          },
        });
        collabRef.current = collab;
        collab.connect();
      }
      if (!cancelled) setPhase("ready");
    })();
    return () => {
      cancelled = true;
      collab?.close();
      if (collabRef.current === collab) collabRef.current = null;
    };
  }, [source, driveId, path, container, retryTick, canWrite, reportDirty]);

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

  const save = useCallback(async () => {
    if (savingRef.current) return false;
    savingRef.current = true;
    const iframe = iframeRef.current;
    let election = false;
    try {
      // Same idea as EuroOffice's lunaSaveLock: one open editor uploads.
      // Denial leaves the diagram dirty so the next autosave tick retries
      // after the other person finishes. Patches keep applying during the
      // wait — the file is what the editor holds when the export starts.
      election = (await collabRef.current?.requestSaveLock()) !== false;
      if (collabRef.current && !election) return false;
      // Apply everything already queued, then freeze. A patch that arrives
      // in the gap between "empty" and the freeze is applied too. Past the
      // deadline, freeze anyway — an unapplied seq stays out of coverage.
      const drainStarted = Date.now();
      while (Date.now() - drainStarted < PATCH_TIMEOUT_MS) {
        if (!pumpingRef.current && patchQueueRef.current.length === 0) {
          exportingRef.current = true;
          if (!pumpingRef.current && patchQueueRef.current.length === 0) break;
          exportingRef.current = false;
        }
        pumpPatchesRef.current();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      exportingRef.current = true;
      const inflightStarted = Date.now();
      while (pumpingRef.current && Date.now() - inflightStarted < PATCH_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Taken once, before export. A confirm that arrives while the bytes
      // are being built must not move this number.
      const coverage = collabRef.current?.snapshotSeq();
      const exportMsg = await requestExport();
      const bytes = diagramBytesFromExport(container, exportMsg);
      const blob = new Blob(
        [/** @type {BlobPart} */ (bytes)],
        { type: DIAGRAM_MIME[container] },
      );
      const coverageOpt = typeof coverage === "number" ? { coverage } : {};
      await source.saveFile(driveId, path, name, blob, coverageOpt);
      collabRef.current?.sendSaved(
        bytes.byteLength,
        typeof coverage === "number" ? coverage : null,
      );
      postToEditor(iframe, { action: "status", message: "", modified: false });
      peerSavedSeqRef.current = undefined;
      dirtySinceRef.current = 0;
      reportDirty(false);
      onSavedRef.current?.();
      return true;
    } finally {
      if (election) collabRef.current?.releaseSaveLock();
      exportingRef.current = false;
      savingRef.current = false;
      pumpPatchesRef.current();
    }
  }, [container, driveId, name, path, reportDirty, requestExport, source]);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (phase !== "ready" || !canWrite) return undefined;
    const id = setInterval(() => {
      const now = Date.now();
      if (!dirtyRef.current) {
        dirtySinceRef.current = 0;
        return;
      }
      if (!dirtySinceRef.current) dirtySinceRef.current = now;
      if (savingRef.current) return;
      // A peer's save may already contain this editor. Recheck every tick:
      // foreign patches and our own acks land after the notice.
      if (peerSavedSeqRef.current !== undefined) {
        const covered = collabRef.current?.editsCoveredBy(peerSavedSeqRef.current) === true;
        if (covered && now - lastEditRef.current >= AUTOSAVE_IDLE_MS) {
          peerSavedSeqRef.current = undefined;
          dirtySinceRef.current = now;
          reportDirty(false);
          const live = iframeRef.current;
          if (live) postToEditor(live, { action: "status", message: "", modified: false });
          return;
        }
      }
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
  }, [phase, canWrite, reportDirty]);

  useEffect(() => {
    if (!docLoaded || !canWrite || !onRegisterSave) return undefined;
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [docLoaded, canWrite, save, onRegisterSave]);

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
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const msg = parseEmbedMessage(event.data);
      if (!msg || !msg.event) return;

      switch (msg.event) {
        case "configure":
          postToEditor(iframe, { action: "configure", config: {} });
          break;
        case "init":
          iframeAliveRef.current = true;
          postToEditor(iframe, {
            action: "load",
            xml: payloadRef.current,
            autosave: 1,
            // Diff patches are the live-edit payload. patchOnly keeps the
            // autosave event small — the file bytes still come from export.
            diffSync: { patchOnly: true },
            title: name,
            modified: "unsavedChanges",
          });
          break;
        case "load":
          docLoadedRef.current = true;
          setDocLoaded(true);
          pumpPatchesRef.current();
          break;
        case "autosave":
          if (applyingRemoteRef.current) break;
          lastEditRef.current = Date.now();
          if (canWrite && msg.patch) {
            collabRef.current?.sendPatch(msg.patch, msg.checksum);
          }
          if (canWrite && !dirtyRef.current) reportDirty(true);
          break;
        case "save":
          lastEditRef.current = Date.now();
          if (canWrite) {
            reportDirty(true);
            const exitAfter = msg.exit === true;
            saveRef.current()
              .then((saved) => {
                if (saved && exitAfter) onCloseRef.current?.();
              })
              .catch(() => {});
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
        case "patch":
          if (pendingPatchRef.current) {
            if (msg.error) pendingPatchRef.current.reject(new Error(String(msg.error)));
            else pendingPatchRef.current.resolve();
          }
          break;
        case "exit":
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
      docLoadedRef.current = false;
      if (pendingExportRef.current) {
        clearTimeout(pendingExportRef.current.timer);
        pendingExportRef.current.reject(new Error("The editor was closed."));
        pendingExportRef.current = null;
      }
      if (pendingPatchRef.current) {
        clearTimeout(pendingPatchRef.current.timer);
        pendingPatchRef.current = null;
      }
    };
  }, [phase, canWrite, name, reportDirty]);

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
        <iframe
          ref={iframeRef}
          src={drawioEmbedUrl({ dark: resolvedTheme === "dark", canWrite })}
          title={`Diagram editor — ${name}`}
          className="h-full min-h-0 w-full flex-1 border-0 bg-primary text-secondary"
          sandbox="allow-scripts allow-same-origin allow-modals allow-popups allow-downloads allow-forms"
          allow="clipboard-read; clipboard-write"
        />
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
  onPresenceChange: PropTypes.func,
  onRegisterSave: PropTypes.func,
  onSaveStateChange: PropTypes.func,
  requestClose: PropTypes.func,
};
