import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./shell/Sidebar.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import BackupPage from "./pages/BackupPage.jsx";
import SyncPage from "./pages/SyncPage.jsx";

function applyTheme() {
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  document.documentElement.classList.toggle("dark", Boolean(dark));
}

export default function App() {
  const [session, setSession] = useState(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [page, setPage] = useState("backup");

  useEffect(() => {
    applyTheme();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme();
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const restored = await invoke("restore_session");
        setSession(restored);
      } catch (e) {
        setBootError(String(e));
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  async function signOut() {
    try {
      await invoke("logout");
    } catch {
      /* still clear UI */
    }
    setSession(null);
    setPage("backup");
  }

  if (booting) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Luna</h1>
          <p>Checking your sign-in…</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        {bootError && (
          <div className="login-page" style={{ paddingBottom: 0 }}>
            <div className="banner error" style={{ maxWidth: "28rem" }}>
              {bootError}
            </div>
          </div>
        )}
        <LoginPage onSignedIn={setSession} />
      </>
    );
  }

  return (
    <div className="shell">
      <Sidebar
        page={page}
        onNavigate={setPage}
        username={session.username}
        onSignOut={signOut}
      />
      <main className="main">
        {page === "backup" ? <BackupPage /> : <SyncPage />}
      </main>
    </div>
  );
}
