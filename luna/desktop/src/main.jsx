import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";

function canUseClipboard() {
  return Boolean(
    typeof window !== "undefined"
      && window.isSecureContext
      && navigator.clipboard?.writeText,
  );
}

function App() {
  const [baseUrl, setBaseUrl] = useState("http://luna.local");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState("");
  const [driveId, setDriveId] = useState("");
  const [drives, setDrives] = useState([]);
  const [status, setStatus] = useState("");
  const [canCopyToken, setCanCopyToken] = useState(false);
  const [manualToken, setManualToken] = useState("");

  async function login() {
    try {
      const message = await invoke("login", { baseUrl, username, password });
      setStatus(message);
      setCanCopyToken(true);
      setManualToken("");
      setDrives(await invoke("list_drives", { baseUrl }));
    } catch (e) { setStatus(String(e)); }
  }
  async function copyToken() {
    try {
      const token = await invoke("copy_access_token");
      if (canUseClipboard()) {
        await navigator.clipboard.writeText(token);
        setCanCopyToken(false);
        setManualToken("");
        setStatus("Access token copied. Paste it as the folder-mount password. It will not stay on this screen.");
      } else {
        setManualToken(token || "");
        setStatus("Select the access token below and copy it. Automatic copy needs a secure connection.");
      }
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
      <p className="hint">Folder backup and one-click mounts. Sign in once; Luna keeps an access token so you never put your Luna password in Finder or Explorer.</p>
      <div className="card">
        <div className="row">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Luna address" />
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Luna password (sign-in only)" />
          <button type="button" onClick={login}>Sign in</button>
        </div>
        {canCopyToken && (
          <button type="button" onClick={copyToken}>
            {manualToken ? "Show access token again" : "Copy access token"}
          </button>
        )}
        {manualToken && (
          <div>
            <p className="hint">Select the text below, then copy it.</p>
            <input
              readOnly
              value={manualToken}
              onFocus={(e) => e.target.select()}
              aria-label="Access token"
            />
          </div>
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
