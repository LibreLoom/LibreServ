import { useEffect, useId, useRef, useState } from "react";
import PropTypes from "prop-types";
import PageNotice from "../../common/PageNotice.jsx";
import Spinner from "../../ui/Spinner.jsx";
import { useAuth } from "../../../context/AuthContext.jsx";
import { useTheme } from "../../../hooks/useTheme.jsx";
import { pathBasename } from "../../../lib/paths.js";
import {
  createEuroOfficeSession,
  euroOfficeDocumentType,
  forceSaveEuroOffice,
  loadEuroOfficeDocsApi,
} from "./euroOfficeApi.js";
import { CollabSocket } from "./collabSocket.js";

const OPEN_TIMEOUT_MS = 45_000;

/**
 * Presence line for the parent fullscreen chrome (FileViewer owns the frame).
 * @param {"loading"|"ready"|"error"} status
 * @param {{ peer_id: number, username: string }[]} peers
 * @param {boolean} canWrite
 * @param {string} [selfName]
 * @param {number | null} [selfPeerId]
 */
function presenceLabel(status, peers, canWrite, selfName = "", selfPeerId = null) {
  const self = String(selfName || "").toLowerCase();
  const others = peers
    .filter((p) =>
      selfPeerId != null
        ? p.peer_id !== selfPeerId
        : p.username && p.username.toLowerCase() !== self,
    )
    .map((p) => p.username)
    .filter(Boolean);
  let base =
    status === "loading"
      ? "Starting EuroOffice…"
      : others.length
        ? `Live · ${others.join(", ")}`
        : "Live · only you";
  if (!canWrite) base = `${base} · view only`;
  return base;
}

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
 * EuroOffice DocsAPI host. FileViewer owns the fullscreen chrome; this component
 * only mounts the editor and reports presence upward.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onPresenceChange?: (label: string) => void,
 *   onSaveStateChange?: (hasUnsaved: boolean) => void,
 *   onRegisterSave?: (save: (() => Promise<unknown>) | null) => void,
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
}) {
  const mountId = useId().replace(/:/g, "");
  const placeholderId = `luna-eurooffice-${mountId}`;
  const editorRef = useRef(/** @type {{ destroyEditor?: () => void } | null} */ (null));
  const { user } = useAuth();
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [peers, setPeers] = useState(/** @type {{ peer_id: number, username: string }[]} */ ([]));
  const [selfPeerId, setSelfPeerId] = useState(/** @type {number | null} */ (null));
  const name = pathBasename(path) || path;
  const uiTheme = resolvedTheme === "dark" ? "theme-dark" : "theme-light";

  useEffect(() => {
    // No room without a real file — an empty path 404s the upgrade, which
    // surfaces in the console as a failed connection.
    if (!driveId || !path) return;
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
  }, [driveId, path]);

  const selfName = user?.display_name || user?.username || "";

  useEffect(() => {
    onPresenceChange?.(presenceLabel(status, peers, canWrite, selfName, selfPeerId));
  }, [status, peers, canWrite, onPresenceChange, selfName, selfPeerId]);

  useEffect(() => {
    let cancelled = false;
    let editor = /** @type {{ destroyEditor?: () => void } | null} */ (null);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;

    (async () => {
      setStatus("loading");
      setError("");
      const docType = euroOfficeDocumentType(path);
      if (!docType) {
        setStatus("error");
        setError("EuroOffice cannot open this file type.");
        return;
      }
      try {
        const session = await createEuroOfficeSession(driveId, path);
        if (cancelled) return;
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

        timeoutId = setTimeout(() => {
          if (cancelled) return;
          setStatus((prev) => {
            if (prev !== "loading") return prev;
            setError(
              "EuroOffice is taking too long to open. Check that Document Server can reach this Luna, then try again.",
            );
            return "error";
          });
        }, OPEN_TIMEOUT_MS);

        editor = new DocsAPI.DocEditor(placeholderId, {
          width: "100%",
          height: "100%",
          type: "desktop",
          documentType: session.document_type || docType,
          document: {
            title: session.title || name,
            url: session.document_url,
            fileType: session.file_type || (name.split(".").pop() || "").toLowerCase(),
            key: session.key,
            permissions: {
              edit: Boolean(write),
              download: true,
              print: true,
              review: Boolean(write),
              comment: Boolean(write),
            },
          },
          editorConfig: {
            mode: write ? "edit" : "view",
            lang: "en",
            callbackUrl: session.callback_url,
            user: { id: userId, name: userName },
            customization: {
              // help/feedback chrome is disabled and the logo is Luna's.
              // AGPL attribution is kept in luna/THIRD_PARTY_EUROOFFICE.md
              // rather than in the editor chrome.
              anonymous: { request: false },
              compactHeader: true,
              compactToolbar: false,
              feedback: false,
              forcesave: true,
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
              if (!cancelled) setStatus("ready");
            },
            onDocumentReady: () => {
              if (!cancelled) setStatus("ready");
            },
            onDocumentStateChange: (event) => {
              if (event?.data === true) {
                onSaveStateChange?.(true);
              } else if (event?.data === false) {
                onSaveStateChange?.(false);
                onSaved?.();
              }
            },
            onError: (event) => {
              const message =
                typeof event?.data === "string"
                  ? event.data
                  : "EuroOffice hit a problem opening this file.";
              if (!cancelled) {
                setError(message);
                setStatus("error");
              }
            },
          },
        });
        editorRef.current = editor;
        // DocsAPI exposes no client-side save command; the thunk asks lunad to
        // send a `forcesave` to the Document Server command service with this
        // session's document key. Only offered when the session can write.
        if (!cancelled && write) {
          onRegisterSave?.(() => forceSaveEuroOffice(driveId, path, session.key));
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setError(
            err instanceof Error
              ? err.message
              : "EuroOffice could not start. Check that the EuroOffice pack on this Luna is complete.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      try {
        editor?.destroyEditor?.();
      } catch {
        // ignore destroy races
      }
      editorRef.current = null;
      onRegisterSave?.(null);
      const node = document.getElementById(placeholderId);
      if (node) node.replaceChildren();
    };
  }, [
    driveId,
    path,
    canWrite,
    name,
    placeholderId,
    user,
    onSaved,
    onSaveStateChange,
    onRegisterSave,
    uiTheme,
  ]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary text-secondary">
      {error ? (
        <div className="shrink-0 px-4 pt-3 pb-3">
          <PageNotice variant="error" surface="primary">
            {error}
          </PageNotice>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {status === "loading" ? (
          <div className="absolute inset-0 z-[1] flex items-center justify-center bg-primary">
            <div className="flex items-center gap-3 text-secondary">
              <p className="font-mono text-sm">Opening in EuroOffice…</p>
              <Spinner size="md" decorative />
            </div>
          </div>
        ) : null}
        <div id={placeholderId} className="h-full w-full" />
      </div>
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
};
