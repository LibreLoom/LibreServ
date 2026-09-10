import { useCallback, useEffect, useRef, useState } from "react";
import { apiErrorMessage, apiFetch, postForm } from "../../../lib/api.js";
import { fileExtension } from "../../../lib/fileKinds.js";
import { extractOfficePlainText } from "../../../lib/officeStubs.js";
import {
  canRoundTripOfficeExt,
  textToOfficeBlob,
} from "../../../lib/officeSave.js";
import { contentHref } from "../../../lib/paths.js";
import Button from "../../ui/Button.jsx";
import Card from "../../cards/Card.jsx";
import PageNotice from "../../common/PageNotice.jsx";
import { CollabSocket } from "./collabSocket.js";

const ENGINE = "luna-fallback/1";
const OP_DEBOUNCE_MS = 120;

/**
 * Lightweight collaborative plain-text office editor.
 * One person edits at a time (server write lease). Saves only OOXML types that
 * can round-trip (docx / xlsx / pptx).
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onClose?: () => void,
 * }} props
 */
export default function FallbackOfficeEditor({
  driveId,
  path,
  canWrite = false,
  onSaved,
  onClose,
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [peers, setPeers] = useState(/** @type {{ peer_id: number, username: string }[]} */ ([]));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** Effective edit right from the collab write lease (not just ACL). */
  const [isEditor, setIsEditor] = useState(false);
  const sockRef = useRef(/** @type {CollabSocket | null} */ (null));
  const applyingRemote = useRef(false);
  const textRef = useRef("");
  const debounceRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const selfPeerId = useRef(/** @type {number | null} */ (null));
  const isEditorRef = useRef(false);
  const ext = fileExtension(path);
  const roundTrip = canRoundTripOfficeExt(ext);
  const mayEdit = canWrite && isEditor;

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    isEditorRef.current = isEditor;
  }, [isEditor]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      setError("");
      try {
        const res = await apiFetch(contentHref(driveId, path));
        if (!res.ok) throw new Error("Luna couldn't open this file.");
        const buf = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;
        setText(await extractOfficePlainText(buf, path));
        setDirty(false);
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driveId, path]);

  useEffect(() => {
    if (status !== "ready") return undefined;
    const sock = new CollabSocket(driveId, path);
    sockRef.current = sock;
    sock.onMessage = (msg) => {
      if (msg.type === "welcome") {
        selfPeerId.current = typeof msg.peer_id === "number" ? msg.peer_id : null;
        setPeers(Array.isArray(msg.peers) ? msg.peers : []);
        setIsEditor(Boolean(msg.can_write));
        for (const ev of Array.isArray(msg.catchup) ? msg.catchup : []) {
          applyOpEvent(ev);
        }
        return;
      }
      if (msg.type === "peer_join") {
        setPeers((prev) => {
          const peer = msg.peer;
          if (!peer || prev.some((p) => p.peer_id === peer.peer_id)) return prev;
          return [...prev, peer];
        });
        return;
      }
      if (msg.type === "peer_leave") {
        setPeers((prev) => prev.filter((p) => p.peer_id !== msg.peer_id));
        return;
      }
      if (msg.type === "editor_changed") {
        const next = msg.peer_id == null ? false : msg.peer_id === selfPeerId.current;
        setIsEditor(next);
        return;
      }
      if (msg.type === "op") {
        applyOpEvent(msg);
        return;
      }
      if (msg.type === "saved") {
        if (selfPeerId.current != null && msg.peer_id === selfPeerId.current) return;
        setDirty(false);
        return;
      }
      if (msg.type === "error" && typeof msg.message === "string") {
        setError(msg.message);
      }
    };
    sock.connect();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      sock.close();
      sockRef.current = null;
      setIsEditor(false);
    };

    function applyOpEvent(ev) {
      if (ev?.type !== "op") return;
      if (selfPeerId.current != null && ev.peer_id === selfPeerId.current) return;
      const payload = ev.payload;
      if (!payload || typeof payload !== "object") return;
      if (payload.engine !== ENGINE || typeof payload.text !== "string") return;
      applyingRemote.current = true;
      setText(payload.text);
      textRef.current = payload.text;
      setDirty(true);
      queueMicrotask(() => {
        applyingRemote.current = false;
      });
    }
  }, [status, driveId, path]);

  const broadcastText = useCallback((next) => {
    if (applyingRemote.current || !isEditorRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      sockRef.current?.sendOp({ engine: ENGINE, text: next });
    }, OP_DEBOUNCE_MS);
  }, []);

  const onChange = useCallback(
    (e) => {
      if (!isEditorRef.current) return;
      const next = e.target.value;
      setText(next);
      setDirty(true);
      broadcastText(next);
    },
    [broadcastText],
  );

  const save = useCallback(async () => {
    if (!mayEdit || !roundTrip) return;
    const blob = textToOfficeBlob(textRef.current, ext);
    if (!blob) {
      setError("This file type cannot be saved from the simple editor without damaging it.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const name = path.split("/").pop() || "document.docx";
      const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
      const form = new FormData();
      form.append("path", folder);
      form.append("file", file);
      await postForm(
        `/api/v1/drives/${encodeURIComponent(driveId)}/files/upload?path=${encodeURIComponent(folder)}&overwrite=1`,
        form,
      );
      sockRef.current?.sendSaved(blob.size);
      setDirty(false);
      onSaved?.();
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't save your changes. Try again."));
    } finally {
      setSaving(false);
    }
  }, [mayEdit, driveId, path, onSaved, roundTrip, ext]);

  if (status === "loading") {
    return (
      <div className="flex h-full min-h-[40vh] items-center justify-center text-primary">
        <p className="font-mono text-sm">Opening…</p>
      </div>
    );
  }

  if (status === "error" && !text) {
    return (
      <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-3 p-6 text-primary">
        <PageNotice variant="error" surface="secondary">{error}</PageNotice>
        {onClose ? (
          <Button type="button" variant="outline" surface="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[50vh] min-w-0 flex-col text-primary">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-primary/20 px-3 py-2">
        <p className="font-mono text-xs text-primary">
          {peers.length
            ? `${peers.length} here: ${peers.map((p) => p.username).join(", ")}`
            : "Connecting…"}
          {mayEdit ? (dirty ? " · unsaved" : " · editing") : " · watching"}
        </p>
        <div className="ml-auto flex flex-wrap gap-2">
          {mayEdit && roundTrip ? (
            <Button
              type="button"
              variant="primary"
              surface="secondary"
              size="sm"
              loading={saving}
              disabled={!dirty}
              onClick={() => void save()}
            >
              Save
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="px-3 pt-2">
          <PageNotice variant="error" surface="secondary">{error}</PageNotice>
        </div>
      ) : null}
      <div className="px-3 pt-2">
        <Card className="!p-3" noPopIn surface="primary">
          <p className="text-sm text-secondary">
            {!canWrite
              ? "You can read this file. Ask someone with edit access if you need to change it."
              : !isEditor
                ? "Someone else is editing right now. You can watch their changes live. When they leave, you can edit."
                : roundTrip
                  ? "Simple editor — one person types at a time. Save writes a basic Office file (rich formatting is not kept)."
                  : `You can take notes live with others. Saving the real ${ext.toUpperCase() || "Office"} file needs EuroOffice on this Luna. Download the original to keep it unchanged.`}
          </p>
        </Card>
      </div>
      <textarea
        className="min-h-[40vh] flex-1 resize-none border-0 bg-secondary p-4 font-mono text-sm text-primary outline-none focus:border-accent"
        value={text}
        onChange={onChange}
        readOnly={!mayEdit}
        spellCheck
        aria-label="Document text"
      />
    </div>
  );
}
