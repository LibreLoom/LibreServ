import React from "react";

export default function Sidebar({ page, onNavigate, username, onSignOut }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Luna</div>
      <nav className="sidebar-nav" aria-label="Main">
        <button
          type="button"
          className={`nav-btn${page === "backup" ? " active" : ""}`}
          onClick={() => onNavigate("backup")}
        >
          Backup
        </button>
        <button
          type="button"
          className={`nav-btn${page === "sync" ? " active" : ""}`}
          onClick={() => onNavigate("sync")}
        >
          Sync
        </button>
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-user">{username || "Signed in"}</div>
        <button type="button" className="sign-out-btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
