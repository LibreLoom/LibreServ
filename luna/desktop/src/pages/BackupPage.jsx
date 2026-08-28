import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import LunaFolderBrowser from "../components/LunaFolderBrowser.jsx";

const emptyDraft = () => ({
  id: "",
  name: "",
  sources: [],
  drive_id: "",
  remote_path: "",
  running: false,
});

export default function BackupPage() {
  const [jobs, setJobs] = useState([]);
  const [progress, setProgress] = useState({});
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [browsePath, setBrowsePath] = useState("");

  const reload = useCallback(async () => {
    try {
      setJobs(await invoke("list_backup_jobs"));
      setProgress(await invoke("backup_progress"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(async () => {
      try {
        setProgress(await invoke("backup_progress"));
        setJobs(await invoke("list_backup_jobs"));
      } catch {
        /* ignore poll errors */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [reload]);

  async function addSource() {
    try {
      const folder = await invoke("pick_folder", {
        title: "Choose a folder to back up",
      });
      setEditing((d) => ({
        ...d,
        sources: d.sources.includes(folder) ? d.sources : [...d.sources, folder],
      }));
    } catch (e) {
      if (!String(e).includes("No folder")) setError(String(e));
    }
  }

  async function saveDraft() {
    setError("");
    try {
      await invoke("save_backup_job", { job: editing });
      setEditing(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function start(id) {
    setError("");
    try {
      await invoke("start_backup_job", { id });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function stop(id) {
    setError("");
    try {
      await invoke("stop_backup_job", { id });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id) {
    setError("");
    try {
      await invoke("delete_backup_job", { id });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Backup</h1>
          <p>Copy folders from this computer onto Luna. One-way — changes on Luna do not come back.</p>
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
            New backup
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}

      {editing && (
        <div className="card wizard">
          <h2>{editing.id ? "Edit backup" : "New backup"}</h2>
          <label className="field">
            Name
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Documents"
            />
          </label>

          <div>
            <div className="muted">Folders on this computer</div>
            <div className="row">
              {editing.sources.map((s) => (
                <span className="chip" key={s}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s}</span>
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        sources: editing.sources.filter((x) => x !== s),
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="btn ghost" onClick={addSource}>
                Add folder
              </button>
            </div>
          </div>

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
            {editing.drive_id && (
              <p className="status-line">
                Destination: {editing.drive_id}
                {editing.remote_path ? ` / ${editing.remote_path}` : " (drive root)"}
              </p>
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

      {!editing && jobs.length === 0 && (
        <div className="empty">No backups yet. Create one to copy folders onto Luna.</div>
      )}

      {jobs.map((job) => {
        const p = progress[job.id] || {};
        return (
          <div className="card" key={job.id}>
            <h2>{job.name || "Backup"}</h2>
            <div className="muted">
              {job.sources.length} folder{job.sources.length === 1 ? "" : "s"} → {job.drive_id}
              {job.remote_path ? ` / ${job.remote_path}` : ""}
            </div>
            {(p.current || p.error || p.uploaded) && (
              <p className="status-line">
                {p.running ? "Running" : "Paused"}
                {p.uploaded ? ` · ${p.uploaded} files` : ""}
                {p.current ? ` · ${p.current}` : ""}
                {p.error ? ` · ${p.error}` : ""}
              </p>
            )}
            <div className="row">
              {job.running ? (
                <button type="button" className="btn ghost" onClick={() => stop(job.id)}>
                  Pause
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => start(job.id)}>
                  Start
                </button>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditing({ ...job });
                  setBrowsePath(job.remote_path || "");
                }}
              >
                Edit
              </button>
              <button type="button" className="btn danger" onClick={() => remove(job.id)}>
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
