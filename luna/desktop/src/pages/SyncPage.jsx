import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import LunaFolderBrowser from "../components/LunaFolderBrowser.jsx";

const emptyDraft = () => ({
  id: "",
  drive_id: "",
  remote_path: "",
  local_parent: "",
  local_path: "",
  running: false,
});

export default function SyncPage() {
  const [pairs, setPairs] = useState([]);
  const [progress, setProgress] = useState({});
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [browsePath, setBrowsePath] = useState("");

  const reload = useCallback(async () => {
    try {
      setPairs(await invoke("list_sync_pairs"));
      setProgress(await invoke("sync_progress"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(async () => {
      try {
        setProgress(await invoke("sync_progress"));
        setPairs(await invoke("list_sync_pairs"));
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [reload]);

  async function pickParent() {
    try {
      const folder = await invoke("pick_folder", {
        title: "Choose where the synced folder should live",
      });
      setEditing((d) => ({ ...d, local_parent: folder }));
    } catch (e) {
      if (!String(e).includes("No folder")) setError(String(e));
    }
  }

  function previewLocalPath() {
    if (!editing?.local_parent || !editing?.remote_path) return "";
    const name = editing.remote_path.split("/").filter(Boolean).pop() || "";
    if (!name) return "";
    const sep = editing.local_parent.endsWith("/") ? "" : "/";
    return `${editing.local_parent}${sep}${name}`;
  }

  async function saveDraft() {
    setError("");
    try {
      await invoke("save_sync_pair", { pair: editing });
      setEditing(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function start(id) {
    setError("");
    try {
      await invoke("start_sync_pair", { id });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function stop(id) {
    setError("");
    try {
      await invoke("stop_sync_pair", { id });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id) {
    setError("");
    try {
      await invoke("delete_sync_pair", { id });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sync</h1>
          <p>
            Keep a Luna folder and a folder on this computer up to date with each other. Changes go both ways.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(emptyDraft());
              setBrowsePath("");
            }}
          >
            New sync
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      {editing && (
        <div className="card wizard">
          <h2>{editing.id ? "Edit sync" : "New sync"}</h2>

          <div>
            <div className="muted">Folder on Luna</div>
            <LunaFolderBrowser
              driveId={editing.drive_id}
              path={browsePath}
              selectedPath={editing.remote_path}
              onPathChange={(p, driveId) => {
                setBrowsePath(p);
                setEditing((d) => ({ ...d, drive_id: driveId || d.drive_id }));
              }}
              onSelect={(p) => setEditing((d) => ({ ...d, remote_path: p }))}
            />
          </div>

          <div>
            <div className="muted">Folder on this computer (the synced folder will be created inside it)</div>
            <div className="row">
              <button type="button" className="btn ghost" onClick={pickParent}>
                Choose folder
              </button>
              {editing.local_parent && <span className="chip">{editing.local_parent}</span>}
            </div>
            {previewLocalPath() && (
              <p className="status-line">Synced folder will be: {previewLocalPath()}</p>
            )}
          </div>

          <div className="row">
            <button type="button" className="btn" onClick={saveDraft}>
              Save
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!editing && pairs.length === 0 && (
        <div className="empty">No syncs yet. Choose a Luna folder and a place for it on this computer.</div>
      )}

      {pairs.map((pair) => {
        const p = progress[pair.id] || {};
        return (
          <div className="card" key={pair.id}>
            <h2>{pair.remote_path || "Sync"}</h2>
            <div className="muted">
              Luna {pair.drive_id}/{pair.remote_path}
              <br />
              This computer: {pair.local_path}
            </div>
            <p className="status-line">
              {p.running || pair.running ? p.phase || "Running" : "Paused"}
              {p.uploaded ? ` · ${p.uploaded} uploaded` : ""}
              {p.downloaded ? ` · ${p.downloaded} downloaded` : ""}
              {p.conflicts ? ` · ${p.conflicts} conflicts` : ""}
              {p.current ? ` · ${p.current}` : ""}
              {p.error ? ` · ${p.error}` : ""}
            </p>
            <div className="row">
              {pair.running ? (
                <button type="button" className="btn ghost" onClick={() => stop(pair.id)}>
                  Pause
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => start(pair.id)}>
                  Start
                </button>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditing({ ...pair });
                  setBrowsePath(pair.remote_path || "");
                }}
              >
                Edit
              </button>
              <button type="button" className="btn danger" onClick={() => remove(pair.id)}>
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
