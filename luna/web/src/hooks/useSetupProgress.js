import { useRef, useCallback } from "react";
import { postJson } from "../lib/api";

/**
 * Persist Luna setup wizard progress to the device (POST /api/v1/setup).
 * Same idea as LibreServ's useSetupProgress: advance saves automatically so a
 * refresh resumes mid-wizard instead of starting over.
 */
export default function useSetupProgress() {
  const seqRef = useRef(0);
  const inFlightRef = useRef(null);

  const saveProgress = useCallback((currentStep, stepData) => {
    const seq = ++seqRef.current;

    const body = {
      current_step: currentStep,
      step_data: stepData || {},
    };

    const promise = postJson("/api/v1/setup", body).then(() => ({ seq }));

    inFlightRef.current = promise;
    // Swallow derived rejection so a failed save is not an unhandled rejection;
    // callers still await the original promise.
    promise
      .finally(() => {
        if (inFlightRef.current === promise) {
          inFlightRef.current = null;
        }
      })
      .catch(() => {});

    return promise;
  }, []);

  const flushProgress = useCallback(async () => {
    if (inFlightRef.current) {
      try {
        await inFlightRef.current;
      } catch {
        /* best-effort flush */
      }
    }
  }, []);

  return { saveProgress, flushProgress };
}
