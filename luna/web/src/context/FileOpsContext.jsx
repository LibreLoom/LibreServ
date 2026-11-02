/* eslint-disable react-refresh/only-export-components */
// One file operation store per browser tab. It mounts above <Routes>, so route
// changes never unmount it and /s/:token (outside AppShell) shares it.

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import PropTypes from "prop-types";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { withCsrfHeaders } from "../lib/api.js";
import { createFileOpsStore } from "../lib/fileOps/store.js";

/** @typedef {ReturnType<typeof createFileOpsStore>} FileOpsStore */

/** @type {import("react").Context<FileOpsStore|null>} */
const FileOpsContext = createContext(null);

/**
 * Leaving the page drops uploads that are still going, so the browser asks first.
 * Jobs Luna has already accepted keep running, so they don't count.
 * @param {FileOpsStore} store
 */
function attachWindowGuards(store) {
  const onBeforeUnload = (/** @type {BeforeUnloadEvent} */ event) => {
    if (!store.hasBrowserWork()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  // Chunked uploads leave a half-written session on Luna; ask it to forget them.
  const onPageHide = () => {
    for (const session of store.openUploadSessions()) {
      const target = session.source.cancelUploadUrl?.(session.uploadId);
      if (!target) continue;
      try {
        void fetch(target.url, {
          method: "DELETE",
          keepalive: true,
          credentials: "include",
          headers: withCsrfHeaders("DELETE", target.headers),
        }).catch(() => {});
      } catch {
        // The page is going away; nothing to report to.
      }
    }
  };
  const onOnline = () => store.retryOffline();
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("online", onOnline);
  return () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("online", onOnline);
  };
}

/**
 * @param {{ children?: import("react").ReactNode, store?: FileOpsStore }} props
 *   `store` lets a test hand in its own store.
 */
export function FileOpsProvider({ children, store: injected }) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const toastRef = useRef(addToast);
  toastRef.current = addToast;
  const storeRef = useRef(/** @type {FileOpsStore|null} */ (injected || null));
  if (!storeRef.current) {
    storeRef.current = createFileOpsStore({
      queryClient,
      addToast: (toast) => toastRef.current(toast),
      haptic,
    });
  }
  const store = storeRef.current;

  useEffect(() => attachWindowGuards(store), [store]);

  return <FileOpsContext.Provider value={store}>{children}</FileOpsContext.Provider>;
}

FileOpsProvider.propTypes = {
  children: PropTypes.node,
  store: PropTypes.object,
};

/**
 * The actions: startUpload, startJobs, startRequest, decide, decideAll, retry,
 * cancel, clearFailed, dismiss, hasBrowserWork. The object never changes.
 * @returns {FileOpsStore}
 */
export function useFileOps() {
  const store = useContext(FileOpsContext);
  if (!store) throw new Error("useFileOps must be used within a FileOpsProvider");
  return store;
}

/**
 * Read state through a selector. The selector must return a stable value for
 * the same state (a field, or one of the memoized helpers in
 * lib/fileOps/selectors.js), never a fresh array or object.
 * @template T
 * @param {(state: import("../lib/fileOps/store.js").FileOpsState) => T} [selector]
 * @returns {T}
 */
export function useFileOpsState(selector) {
  const store = useFileOps();
  const read = () => {
    const state = store.getState();
    return selector ? selector(state) : /** @type {any} */ (state);
  };
  return useSyncExternalStore(store.subscribe, read, read);
}
