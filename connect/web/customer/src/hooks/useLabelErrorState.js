import { useEffect, useRef, useState } from "react";
import { serializeShakeTrigger } from "../utils/shake.js";

/**
 * Drives label error color: red on failure, fades to normal on form resubmit,
 * returns to red if the field is still invalid after the attempt completes.
 *
 * @param {unknown} error
 * @param {unknown} [shake]
 * @param {{ loading?: boolean, enabled?: boolean }} [options]
 * @returns {{ labelError: boolean, containerRef: import("react").RefObject<HTMLDivElement|null> }}
 */
export default function useLabelErrorState(error, shake, options = {}) {
  const { loading = false, enabled = true } = options;
  const [labelError, setLabelError] = useState(false);
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const prevTrigger = useRef("");
  const prevLoading = useRef(false);
  const awaitingResult = useRef(false);

  const trigger = serializeShakeTrigger(error) || serializeShakeTrigger(shake);

  useEffect(() => {
    if (!enabled) return;

    const el = containerRef.current;
    const form = el?.closest("form");
    if (!form) return;

    const onSubmit = () => {
      awaitingResult.current = true;
      setLabelError(false);
    };

    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLabelError(false);
      return;
    }

    if (!trigger) {
      if (!awaitingResult.current) {
        setLabelError(false);
      }
      prevTrigger.current = "";
      return;
    }

    if (trigger !== prevTrigger.current) {
      setLabelError(true);
      awaitingResult.current = false;
    }
    prevTrigger.current = trigger;
  }, [trigger, enabled]);

  useEffect(() => {
    if (!enabled) return;

    if (prevLoading.current && !loading && awaitingResult.current && trigger) {
      setLabelError(true);
      awaitingResult.current = false;
    }
    prevLoading.current = loading;
  }, [loading, trigger, enabled]);

  return { labelError, containerRef };
}
