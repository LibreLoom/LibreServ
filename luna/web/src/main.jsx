import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

async function start() {
  // Dev only: the testing gallery (/__states), the file operation playground
  // (/__playground) and the fake Luna they drive. All of it sits behind
  // import.meta.env.DEV so production builds drop them.
  if (import.meta.env.DEV) {
    if (window.location.pathname.startsWith("/__states")) {
      const { mountGallery } = await import("./dev/gallery/mount.jsx");
      mountGallery();
      return;
    }
    if (window.location.pathname.startsWith("/__playground")) {
      const { mountPlayground } = await import("./dev/playground/mount.jsx");
      mountPlayground();
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
