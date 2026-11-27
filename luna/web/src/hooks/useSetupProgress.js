import { useRef, useCallback } from "react";
import { postJson } from "../lib/api";

/**
 * Persist Luna setup wizard progress to the device (POST /api/v1/setup).
 * Same idea as Sol's useSetupProgress: advance saves automatically so a
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

    // The newest click owns the newest record even if an earlier request is
    // slow. Serial writes keep a late response from moving setup backwards.
    const write = () => postJson("/api/v1/setup", body).then(() => ({ seq }));
    const pending = inFlightRef.current;
    const promise = pending ? pending.then(write, write) : write();

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
    while (inFlightRef.current) {
      try {
        await inFlightRef.current;
      } catch {
        // A failed write has still left the queue.
      }
    }
  }, []);

  return { saveProgress, flushProgress };
}
