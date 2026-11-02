import { createRoot } from "react-dom/client";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import Playground from "./Playground.jsx";
import "../../index.css";

/** Mounts the file operation playground in place of the app (dev only, /__playground). */
export function mountPlayground() {
  createRoot(document.getElementById("root")).render(
    <ToastProvider>
      <ShortcutsProvider>
        <Playground />
        <Toaster />
      </ShortcutsProvider>
    </ToastProvider>,
  );
}
