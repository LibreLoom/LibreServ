import { useEffect, useState } from "react";

/**
 * Whether the tab is currently visible. Timed UI (toasts, transient status)
 * uses this to pause its wall-clock timer while the phone is locked or the
 * browser is in the background, so coming back doesn't reveal an empty screen
 * where a notification used to be.
 */
export function useDocumentVisible() {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden
  );

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}

export default useDocumentVisible;
