import { useRef, useCallback } from "react";
import api from "../lib/api";

export default function useSetupProgress() {
  const seqRef = useRef(0);
  const inFlightRef = useRef(null);

  const saveProgress = useCallback((currentStep, currentSubStep, stepData) => {
    const seq = ++seqRef.current;

    const body = {
      current_step: currentStep,
      current_sub_step: currentSubStep || "",
      step_data: stepData || {},
    };

    const promise = api("/setup/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(() => ({ seq }));

    inFlightRef.current = promise;
    // .finally() returns a derived promise that also rejects when `promise`
    // rejects; swallow it so a failed save doesn't surface as an unhandled
    // rejection. The caller still sees the original rejection via `promise`.
    promise.finally(() => {
      if (inFlightRef.current === promise) {
        inFlightRef.current = null;
      }
    }).catch(() => {});

    return promise;
  }, []);

  const flushProgress = useCallback(async () => {
    if (inFlightRef.current) {
      try { await inFlightRef.current; } catch { /* best-effort flush */ }
    }
  }, []);

  return { saveProgress, flushProgress };
}
