import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";

function App() {
  const [baseUrl, setBaseUrl] = useState("http://luna.local");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState("");
  const [driveId, setDriveId] = useState("");
  const [drives, setDrives] = useState([]);
  const [status, setStatus] = useState("");

  async function login() {
    try {
      setStatus(await invoke("login", { baseUrl, username, password }));
      setDrives(await invoke("list_drives", { baseUrl }));
      setStatus("Signed in. Pick a folder and drive, then start backup.");
    } catch (e) { setStatus(String(e)); }
  }
  async function pickFolder() {
    try { setFolder(await invoke("pick_folder")); } catch (e) { setStatus(String(e)); }
  }
  async function start() {
    try { setStatus(await invoke("start_backup", { baseUrl, folder, driveId, remotePath: "Desktop Backup" })); } catch (e) { setStatus(String(e)); }
  }
  async function mount() {
    try { setStatus(await invoke("mount_drive", { baseUrl, driveId })); } catch (e) { setStatus(String(e)); }
  }

  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>Luna Desktop</h1>
      <p>Folder backup + one-click mounts. No subscription, ever.</p>
      <div>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Luna address" />
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
        <button onClick={login}>Sign in</button>
      </div>
      <div>
        <button onClick={pickFolder}>Choose folder</button>
        <span>{folder}</span>
      </div>
      <div>
        <select value={driveId} onChange={(e) => setDriveId(e.target.value)}>
          <option value="">Choose drive</option>
          {drives.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <button onClick={start}>Start backup</button>
        <button onClick={mount}>Open as folder</button>
      </div>
      <p>{status}</p>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
