import { useEffect, useId, useRef, useState } from "react";
import PropTypes from "prop-types";
import PageNotice from "../../common/PageNotice.jsx";
import { useAuth } from "../../../context/AuthContext.jsx";
import { contentHref, pathBasename } from "../../../lib/paths.js";
import {
  euroOfficeDocumentKey,
  euroOfficeDocumentType,
  loadEuroOfficeDocsApi,
} from "./euroOfficeApi.js";
import { CollabSocket } from "./collabSocket.js";

/**
 * Fullscreen EuroOffice DocsAPI host with Luna collab presence.
 * No Luna-built-in editor — EuroOffice is the only editor surface.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 * }} props
 */
export default function EuroOfficeHost({ driveId, path, canWrite = false, onSaved }) {
  const mountId = useId().replace(/:/g, "");
  const placeholderId = `luna-eurooffice-${mountId}`;
  const editorRef = useRef(/** @type {{ destroyEditor?: () => void } | null} */ (null));
  const { user } = useAuth();
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [peers, setPeers] = useState(/** @type {{ peer_id: number, username: string }[]} */ ([]));
  const name = pathBasename(path) || path;

  useEffect(() => {
    const sock = new CollabSocket(driveId, path);
    sock.onMessage = (msg) => {
      if (msg?.type === "welcome") {
        setPeers(Array.isArray(msg.peers) ? msg.peers : []);
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

  useEffect(() => {
    let cancelled = false;
    let editor = /** @type {{ destroyEditor?: () => void } | null} */ (null);

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
        const DocsAPI = await loadEuroOfficeDocsApi();
        if (cancelled) return;
        const url = new URL(contentHref(driveId, path), window.location.origin).toString();
        const userName =
          user?.display_name || user?.username || (canWrite ? "Editor" : "Viewer");
        const userId = user?.id != null ? String(user.id) : "luna-user";

        editor = new DocsAPI.DocEditor(placeholderId, {
          width: "100%",
          height: "100%",
          type: "desktop",
          documentType: docType,
          document: {
            title: name,
            url,
            fileType: (name.split(".").pop() || "").toLowerCase(),
            key: euroOfficeDocumentKey(driveId, path),
            permissions: {
              edit: Boolean(canWrite),
              download: true,
              print: true,
              review: Boolean(canWrite),
              comment: Boolean(canWrite),
            },
          },
          editorConfig: {
            mode: canWrite ? "edit" : "view",
            lang: "en",
            user: { id: userId, name: userName },
            customization: {
              anonymous: { request: false },
              compactHeader: true,
              compactToolbar: false,
              feedback: false,
              forcesave: true,
              help: false,
              hideRightMenu: false,
              autosave: true,
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
              // EuroOffice reports dirty state; saves are owned by EuroOffice.
              if (event?.data === false) onSaved?.();
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
      try {
        editor?.destroyEditor?.();
      } catch {
        // ignore destroy races
      }
      editorRef.current = null;
      const node = document.getElementById(placeholderId);
      if (node) node.replaceChildren();
    };
  }, [driveId, path, canWrite, name, placeholderId, user, onSaved]);

  const others = peers
    .map((p) => p.username)
    .filter(Boolean);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary text-secondary">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-secondary/20 px-4 py-2 pr-16 md:pr-20">
        <p className="min-w-0 truncate font-mono text-xs text-secondary">
          {status === "loading"
            ? "Starting EuroOffice…"
            : others.length
              ? `Live · ${others.join(", ")}`
              : "Live · only you"}
          {canWrite ? "" : " · view only"}
        </p>
        <p className="ml-auto hidden font-mono text-[10px] text-secondary sm:block">
          EuroOffice (AGPL)
        </p>
      </div>
      {error ? (
        <div className="shrink-0 px-4 pt-3">
          <PageNotice variant="error" surface="primary">
            {error}
          </PageNotice>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {status === "loading" ? (
          <div className="absolute inset-0 z-[1] flex items-center justify-center bg-primary">
            <p className="font-mono text-sm text-secondary motion-safe:animate-pulse">
              Opening in EuroOffice…
            </p>
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
};
