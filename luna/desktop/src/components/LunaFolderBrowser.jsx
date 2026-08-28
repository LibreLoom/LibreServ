import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Browse folders on a Luna drive; optionally create a new folder.
 */
export default function LunaFolderBrowser({
  driveId,
  path,
  onPathChange,
  onSelect,
  selectedPath,
}) {
  const [drives, setDrives] = useState([]);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke("list_drives")
      .then(setDrives)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!driveId) {
      setEntries([]);
      return;
    }
    setBusy(true);
    invoke("list_files", { driveId, path: path || "" })
      .then((list) => setEntries(list.filter((e) => e.kind === "dir")))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [driveId, path]);

  const crumbs = (path || "").split("/").filter(Boolean);

  async function createFolder() {
    const name = newName.trim();
    if (!name || !driveId) return;
    const full = path ? `${path}/${name}` : name;
    setError("");
    try {
      await invoke("mkdir", { driveId, path: full });
      setNewName("");
      const list = await invoke("list_files", { driveId, path: path || "" });
      setEntries(list.filter((e) => e.kind === "dir"));
      onSelect?.(full);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <label className="field" style={{ flex: 1, minWidth: "10rem" }}>
          Drive
          <select
            value={driveId || ""}
            onChange={(e) => {
              onPathChange?.("", e.target.value);
            }}
          >
            <option value="">Choose a drive</option>
            {drives.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {driveId && (
        <>
          <div className="browser-bar">
            <button type="button" className="crumb" onClick={() => onPathChange?.("", driveId)}>
              Drive root
            </button>
            {crumbs.map((c, i) => {
              const next = crumbs.slice(0, i + 1).join("/");
              return (
                <React.Fragment key={next}>
                  <span>/</span>
                  <button type="button" className="crumb" onClick={() => onPathChange?.(next, driveId)}>
                    {c}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          <ul className="file-list">
            {busy && <li className="muted">Loading…</li>}
            {!busy && entries.length === 0 && (
              <li className="muted">No folders here yet. You can create one below.</li>
            )}
            {entries.map((e) => {
              const full = path ? `${path}/${e.name}` : e.name;
              return (
                <li key={full}>
                  <button
                    type="button"
                    className={selectedPath === full ? "selected" : ""}
                    onDoubleClick={() => onPathChange?.(full, driveId)}
                    onClick={() => onSelect?.(full)}
                  >
                    {e.name}/
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="row">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New folder name"
              style={{
                flex: 1,
                borderRadius: 9999,
                border: "2px solid color-mix(in srgb, var(--secondary) 30%, transparent)",
                background: "var(--secondary)",
                color: "var(--primary)",
                padding: "0.45rem 0.9rem",
              }}
            />
            <button type="button" className="btn" onClick={createFolder} disabled={!newName.trim()}>
              Create folder
            </button>
            <button type="button" className="btn ghost" onClick={() => onSelect?.(path || "")}>
              Use this folder
            </button>
          </div>
        </>
      )}
      {error && <p className="status-line">{error}</p>}
    </div>
  );
}
