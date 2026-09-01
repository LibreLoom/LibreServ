import { useEffect, useRef } from "react";
import { serializeShakeTrigger, shakeElement } from "../utils/shake.js";

/**
 * Shakes `ref` when `trigger` becomes a new non-empty failure signal.
 * @param {unknown} trigger
 * @param {import("react").RefObject<Element | null>} ref
 */
export default function useShakeOnError(trigger, ref) {
  const previousTrigger = useRef("");

  useEffect(() => {
    const nextTrigger = serializeShakeTrigger(trigger);
    if (!nextTrigger) {
      previousTrigger.current = "";
      return;
    }
    if (nextTrigger !== previousTrigger.current) {
      shakeElement(ref.current);
    }
    previousTrigger.current = nextTrigger;
  }, [trigger, ref]);
}
