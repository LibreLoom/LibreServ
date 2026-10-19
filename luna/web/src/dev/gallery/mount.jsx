import { createRoot } from "react-dom/client";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import Gallery from "./Gallery.jsx";
import "../../index.css";

/** Mounts the testing gallery in place of the app (dev only, route /__states). */
export function mountGallery() {
  // The gallery follows the system theme; the app inside the frame has its own.
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", Boolean(dark));
  createRoot(document.getElementById("root")).render(
    <ToastProvider>
      <ShortcutsProvider>
        <Gallery />
        <Toaster />
      </ShortcutsProvider>
    </ToastProvider>,
  );
}
