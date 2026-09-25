import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { BookOpen, Code, Download, Pencil } from "lucide-react";
import MarkdownEditor from "./MarkdownEditor.jsx";
import PlainTextSurface from "./PlainTextSurface.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { CollabDocSync } from "./collabDocSync.js";
import { apiErrorMessage } from "../../lib/api.js";
import { useFileSource } from "../../lib/fileSource.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

// Autosave mirrors EuroOfficeHost: fire once typing pauses for
// AUTOSAVE_IDLE_MS, never let unsaved work age past AUTOSAVE_MAX_MS during
// continuous typing, and back off AUTOSAVE_RETRY_MS after a failed save.
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MAX_MS = 15_000;
const AUTOSAVE_RETRY_MS = 5_000;
const AUTOSAVE_TICK_MS = 250;

/**
 * Fullscreen plaintext/markdown editor — the writable counterpart to the
 * modal's read-only text preview. Mounts inside FullscreenEditorFrame and
 * plugs into its save contract: registers an upload thunk once the session
 * is up and reports dirty state so the frame's guard modal, Save button,
 * and beforeunload all work.
 *
 * Every session is a collab session: a shared Yjs document syncs over
 * Luna's collab WebSocket hub, so a second person opening the same file
 * joins with live cursors instead of a separate copy. Alone in the room,
 * the doc seeds from the file on the drive; if the socket never connects,
 * the editor still works and save writes the local document.
 *
 * The outer split keys the session on drive+path: switching files inside
 * one frame remounts the session rather than leaking one file's document
 * (or its peers) into the next.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   name: string,
 *   isMarkdown?: boolean,
 *   onSaved?: () => void,
 *   onRegisterSave: (save: (() => Promise<unknown>) | null) => void,
 *   onSaveStateChange: (hasUnsaved: boolean) => void,
 * }} props
 */
export default function TextFileEditor(props) {
  return <EditorSession key={`${props.driveId}:${props.path}`} {...props} />;
}

TextFileEditor.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  isMarkdown: PropTypes.bool,
  onSaved: PropTypes.func,
  onRegisterSave: PropTypes.func.isRequired,
  onSaveStateChange: PropTypes.func.isRequired,
};

/**
 * @param {Parameters<typeof TextFileEditor>[0]} props
 */
function EditorSession({
  driveId,
  path,
  name,
  isMarkdown = false,
  onSaved,
  onRegisterSave,
  onSaveStateChange,
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  /** What the drive holds — the dirty baseline. Null until the fetch lands. */
  const [baseline, setBaseline] = useState(/** @type {string|null} */ (null));
  const [peers, setPeers] = useState(/** @type {object[]} */ ([]));
  const [connStatus, setConnStatus] = useState("connecting");
  const [mdMode, setMdMode] = useState(/** @type {"write"|"source"|"read"} */ ("write"));
  const [stats, setStats] = useState({ line: 1, col: 1, words: 0 });
  const source = useFileSource();
  // Guests have no session for the collab hub — solo mode seeds the doc
  // straight from the file and saves through the link instead.
  const solo = source.collab === false;
  // Bump on every document update so dirty state and the read-mode preview
  // see remote edits, not just local keystrokes.
  const [, setDocVersion] = useState(0);
  const syncRef = useRef(/** @type {CollabDocSync | null} */ (null));
  // Autosave bookkeeping. `baselineRef` mirrors the `baseline` state so the
  // tick reads the latest disk copy without re-arming the interval.
  const baselineRef = useRef(/** @type {string | null} */ (null));
  baselineRef.current = baseline;
  const lastEditRef = useRef(0);
  const dirtySinceRef = useRef(0);
  const lastSaveAttemptRef = useRef(0);
  const savingRef = useRef(false);
  // One shared document per mounted session — created during render (pure
  // object construction), connected in the effect below.
  const [sync] = useState(
    () =>
      new CollabDocSync({
        driveId,
        path,
        solo,
        onPeers: (next) => setPeers(next),
        onStatus: (status) => setConnStatus(status),
        // A peer's save lands as a broadcast — the drive now holds (very
        // nearly) this document, so our dirty baseline moves with it.
        onPeerSaved: () => {
          const s = syncRef.current;
          if (s) setBaseline(s.serialize());
        },
      }),
  );
  syncRef.current = sync;

  useEffect(() => {
    let cancelled = false;
    const onDocUpdate = () => {
      setDocVersion((v) => v + 1);
      // Remote ops count too — a peer's edit also leaves the doc ahead of
      // the file on the drive.
      lastEditRef.current = Date.now();
    };
    sync.ydoc.on("update", onDocUpdate);
    sync.connect();

    (async () => {
      try {
        const res = await source.fetch(source.contentHref(driveId, path));
        if (!res.ok) throw new Error("Luna couldn't open this file.");
        const body = await res.text();
        if (cancelled) return;
        setBaseline(body);
        sync.adoptContent(body);
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      sync.ydoc.off("update", onDocUpdate);
      // Disconnect rather than destroy: StrictMode replays this effect, and
      // the same document must survive into the second mount.
      sync.disconnect();
    };
  }, [sync, driveId, path, source]);

  // Dirty only counts once the shared doc is hydrated — between the fetch
  // resolving (baseline set) and the seed/sync landing, the doc is empty by
  // timing, not by fact.
  const isDirty =
    sync.hydrated && baseline != null && sync.serialize() !== baseline;
  // Report dirty upward; the clean report happens inside save() so the
  // frame's "Saved just now" stamp only fires on a real save, not on load.
  useEffect(() => {
    if (isDirty) onSaveStateChange(true);
  }, [isDirty, onSaveStateChange]);

  const save = useCallback(async () => {
    const session = syncRef.current;
    // A second in-flight save (frame button vs autosave tick) reports false
    // so the caller can tell "nothing ran" from "saved".
    if (!session || savingRef.current) return false;
    savingRef.current = true;
    try {
      const body = session.serialize();
      await source.saveFile(driveId, path, name, new Blob([body], { type: "text/plain" }));
      setBaseline(body);
      session.notifySaved(body.length);
      onSaved?.();
      onSaveStateChange(false);
      return true;
    } finally {
      savingRef.current = false;
    }
  }, [source, driveId, path, name, onSaved, onSaveStateChange]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Autosave tick. Peer saves move the baseline, so a doc they covered
  // stands down on its own — the tick re-checks dirtiness every pass rather
  // than latching a flag.
  useEffect(() => {
    if (loading || error) return undefined;
    const id = setInterval(() => {
      const session = syncRef.current;
      const now = Date.now();
      const dirty =
        session != null &&
        session.hydrated &&
        baselineRef.current != null &&
        session.serialize() !== baselineRef.current;
      if (!dirty) {
        dirtySinceRef.current = 0;
        return;
      }
      if (!dirtySinceRef.current) dirtySinceRef.current = now;
      if (savingRef.current) return;
      if (now - lastSaveAttemptRef.current < AUTOSAVE_RETRY_MS) return;
      const idle = now - lastEditRef.current;
      const stale = now - dirtySinceRef.current;
      if (idle >= AUTOSAVE_IDLE_MS || stale >= AUTOSAVE_MAX_MS) {
        lastSaveAttemptRef.current = now;
        saveRef.current?.().catch(() => {
          // keep editing; the tick retries after AUTOSAVE_RETRY_MS
        });
      }
    }, AUTOSAVE_TICK_MS);
    return () => clearInterval(id);
  }, [loading, error]);

  // Register the save thunk once the session is up — Save stays disabled
  // until then, matching the office editor's "no session, no save" behavior.
  useEffect(() => {
    if (loading || error || !sync) return undefined;
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [loading, error, sync, save, onRegisterSave]);

  const peerNames = peers.map((p) => p.username).join(", ");
  const connNote =
    connStatus === "open"
      ? peers.length > 0
        ? `Editing together: ${peerNames}`
        : ""
      : connStatus === "connecting" || connStatus === "reconnecting"
        ? "Connecting…"
        : "Offline — your changes stay here and sync when Luna reconnects";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-secondary/15 px-3">
        {isMarkdown ? (
          <SegmentedControl
            options={[
              { value: "write", label: "Write", icon: Pencil },
              {
                value: "source",
                label: "Source",
                icon: Code,
                title: "Edit the raw Markdown text",
              },
              { value: "read", label: "Read", icon: BookOpen },
            ]}
            value={mdMode}
            onChange={(v) => setMdMode(v === "source" ? "source" : v === "read" ? "read" : "write")}
            surface="primary"
            aria-label="Editing mode"
          />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          {peers.length > 0 && (
            <span
              className="mr-1 flex items-center"
              role="img"
              aria-label={`Also editing: ${peerNames}`}
              title={`Also editing: ${peerNames}`}
            >
              {peers.slice(0, 5).map((peer) => (
                <span
                  key={peer.peer_id}
                  className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-full text-[0.65rem] text-primary first:ml-0 ring-2 ring-primary"
                  style={{ backgroundColor: peer.color }}
                  aria-hidden="true"
                >
                  {String(peer.username || "?").slice(0, 1).toUpperCase()}
                </span>
              ))}
              {peers.length > 5 && (
                <span className="-ml-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1 text-[0.65rem] text-primary ring-2 ring-primary">
                  +{peers.length - 5}
                </span>
              )}
            </span>
          )}
          <Button
            variant="ghost"
            surface="primary"
            size="iconSm"
            smoothResize={false}
            haptic="light"
            aria-label="Download"
            tooltip="Download"
            asChild
          >
            <a href={source.downloadHref(driveId, path)}>
              <Download size={ICON_SIZE.md} aria-hidden="true" />
            </a>
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        {loading ? (
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
        ) : error ? (
          <PageNotice variant="error">{error}</PageNotice>
        ) : isMarkdown ? (
          <MarkdownEditor
            sync={sync}
            driveId={driveId}
            path={path}
            name={name}
            canWrite
            mode={mdMode}
            error={error}
            onStats={setStats}
            fill
          />
        ) : (
          <ShakeTarget shake={error} className="flex h-full min-h-0 flex-col">
            <PlainTextSurface
              sync={sync}
              name={name}
              canWrite
              onStats={setStats}
              fill
            />
          </ShakeTarget>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-secondary/15 px-4 text-xs text-accent">
        <span className="font-mono">
          Ln {stats.line}, Col {stats.col} · {stats.words}{" "}
          {stats.words === 1 ? "word" : "words"}
        </span>
        <span className="truncate">
          {connNote ||
            (isMarkdown ? (
              <TermHint
                content="Markdown is a plain-text way to add formatting — headings, lists, links. In Write mode you see the result as you type; Source shows the raw marks."
                surface="primary"
              >
                Markdown
              </TermHint>
            ) : (
              "Plain text"
            ))}
        </span>
      </div>
    </div>
  );
}

EditorSession.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  isMarkdown: PropTypes.bool,
  onSaved: PropTypes.func,
  onRegisterSave: PropTypes.func.isRequired,
  onSaveStateChange: PropTypes.func.isRequired,
};
