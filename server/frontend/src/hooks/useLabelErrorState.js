import { useCallback, useEffect, useRef, useState } from "react";
import { serializeShakeTrigger } from "../utils/shake";

/**
 * Drives label error color: red on failure, fades to normal on form resubmit,
 * returns to red if the field is still invalid after the attempt completes.
 *
 * @param {unknown} error
 * @param {unknown} [shake]
 * @param {{ loading?: boolean, enabled?: boolean }} [options]
 * @returns {{ labelError: boolean, containerRef: (node: HTMLElement | null) => void }}
 */
export default function useLabelErrorState(error, shake, options = {}) {
  const { loading = false, enabled = true } = options;
  const [rootEl, setRootEl] = useState(/** @type {HTMLElement | null} */ (null));
  const [retrying, setRetrying] = useState(false);
  const sawLoadingDuringRetry = useRef(false);
  const containerRef = useCallback((node) => {
    setRootEl(node);
  }, []);

  const trigger = serializeShakeTrigger(error) || serializeShakeTrigger(shake);

  useEffect(() => {
    if (!enabled || !rootEl) return;

    const form = rootEl.closest("form");
    if (!form) return;

    const onSubmit = () => {
      sawLoadingDuringRetry.current = false;
      setRetrying(true);
    };

    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [enabled, rootEl]);

  useEffect(() => {
    if (retrying && loading) {
      sawLoadingDuringRetry.current = true;
    }
    if (!retrying) {
      sawLoadingDuringRetry.current = false;
    }
  }, [retrying, loading]);

  const labelError =
    enabled && !!trigger && (!retrying || (sawLoadingDuringRetry.current && !loading));

  return { labelError, containerRef };
}
