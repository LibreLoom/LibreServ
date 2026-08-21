import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";

function App() {
  const [baseUrl, setBaseUrl] = useState("http://luna.local");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState("");
  const [driveId, setDriveId] = useState("");
  const [drives, setDrives] = useState([]);
  const [status, setStatus] = useState("");
  const [accessToken, setAccessToken] = useState("");

  async function login() {
    try {
      const message = await invoke("login", { baseUrl, username, password });
      setStatus(message);
      const tokenLine = String(message).split("\n")[1] || "";
      setAccessToken(tokenLine.trim());
      setDrives(await invoke("list_drives", { baseUrl }));
    } catch (e) { setStatus(String(e)); }
  }
  async function pickFolder() {
    try { setFolder(await invoke("pick_folder")); } catch (e) { setStatus(String(e)); }
  }
  async function start() {
    try { setStatus(await invoke("start_backup", { baseUrl, folder, driveId, remotePath: "Desktop Backup" })); } catch (e) { setStatus(String(e)); }
  }
  async function stop() {
    try { setStatus(await invoke("stop_backup")); } catch (e) { setStatus(String(e)); }
  }
  async function mount() {
    try { setStatus(await invoke("mount_drive", { baseUrl, driveId })); } catch (e) { setStatus(String(e)); }
  }

  return (
    <main className="page">
      <h1>Luna Desktop</h1>
      <p className="hint">Folder backup and one-click mounts. Sign in once; Luna keeps an access token so you never put your household password in Finder or Explorer.</p>
      <div className="card">
        <div className="row">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Luna address" />
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Household password (sign-in only)" />
          <button type="button" onClick={login}>Sign in</button>
        </div>
        {accessToken && (
          <p className="token">Access token (use this as the folder-mount password): {accessToken}</p>
        )}
      </div>
      <div className="card">
        <div className="row">
          <button type="button" onClick={pickFolder}>Choose folder</button>
          <span>{folder}</span>
        </div>
        <div className="row">
          <select value={driveId} onChange={(e) => setDriveId(e.target.value)}>
            <option value="">Choose drive</option>
            {drives.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <button type="button" onClick={start}>Start backup</button>
          <button type="button" onClick={stop}>Stop backup</button>
          <button type="button" onClick={mount}>Open as folder</button>
        </div>
      </div>
      <p className="hint">{status}</p>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
