import { useEffect } from "react";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

/**
 * Route a shared "action error" string to the right surface.
 * While a dialog/sheet is open (`surfaceOpen`), the caller keeps rendering the
 * error inline (ModalErrorNotice / submitError) — the open surface owns it.
 * When nothing is open, the error is announced as an error toast once and the
 * state is cleared, so transient failures don't linger as page banners.
 *
 * @param {string|null} error
 * @param {boolean} surfaceOpen
 * @param {() => void} clear
 */
export default function useStrandedErrorToast(error, surfaceOpen, clear) {
  const { addToast } = useToast();
  useEffect(() => {
    if (!error || surfaceOpen) return;
    addToast({ type: "error", message: error });
    clear();
  }, [error, surfaceOpen, clear, addToast]);
}
