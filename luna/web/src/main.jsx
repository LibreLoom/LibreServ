import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { initPerf } from "./lib/perf.js";
import { startShareEarly } from "./lib/shareEarly.js";
import "./index.css";

async function start() {
  // Journey timing for luna/perf (devtools and the perf spec only; no UI).
  initPerf();
  // A guest's share link: ask for its meta and listing now (W15).
  startShareEarly();
  // Dev only: the testing gallery (/__states) and the fake Luna it drives. Both
  // sit behind import.meta.env.DEV so production builds drop them.
  if (import.meta.env.DEV) {
    if (window.location.pathname.startsWith("/__states")) {
      const { mountGallery } = await import("./dev/gallery/mount.jsx");
      mountGallery();
      return;
    }
    const { bootMock } = await import("./dev/boot.js");
    bootMock();
  }
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

start();
