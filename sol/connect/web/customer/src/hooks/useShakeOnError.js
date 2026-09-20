import { useEffect, useRef, useState } from "react";
import { serializeShakeTrigger, shakeElement } from "../utils/shake.js";

/**
 * Shakes `ref` when `trigger` becomes a new failure signal, and again on
 * form resubmit while the field is still failing.
 *
 * @param {unknown} trigger
 * @param {import("react").RefObject<Element | null>} ref
 * @param {{ loading?: boolean }} [options] Pass `loading` for async submits so
 *   the shake waits until the attempt finishes; omit it for instant client-side
 *   validation reshakes.
 */
export default function useShakeOnError(trigger, ref, options) {
  const loading = options?.loading;
  const previousTrigger = useRef("");
  const [resubmitBeat, setResubmitBeat] = useState(0);
  const sawLoadingDuringResubmit = useRef(false);
  const prevLoading = useRef(false);
  const usesLoadingCycle = options != null && "loading" in options;

  const activeTrigger = serializeShakeTrigger(trigger);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const form = el.closest("form");
    if (!form) return;

    const onSubmit = () => {
      if (previousTrigger.current) {
        sawLoadingDuringResubmit.current = false;
        setResubmitBeat((n) => n + 1);
      }
    };

    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [ref]);

  useEffect(() => {
    if (!activeTrigger) {
      previousTrigger.current = "";
      return;
    }
    if (activeTrigger !== previousTrigger.current) {
      shakeElement(ref.current);
    }
    previousTrigger.current = activeTrigger;
  }, [activeTrigger, ref]);

  useEffect(() => {
    if (resubmitBeat === 0 || !activeTrigger) return;

    if (!usesLoadingCycle) {
      shakeElement(ref.current);
      return;
    }

    if (loading) {
      sawLoadingDuringResubmit.current = true;
    }

    if (prevLoading.current && !loading && sawLoadingDuringResubmit.current) {
      shakeElement(ref.current);
      sawLoadingDuringResubmit.current = false;
    }
    prevLoading.current = !!loading;
  }, [resubmitBeat, loading, activeTrigger, ref, usesLoadingCycle]);
}
