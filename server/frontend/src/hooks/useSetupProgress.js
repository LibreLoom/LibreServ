import { useRef, useCallback } from "react";
import api from "../lib/api";

export default function useSetupProgress() {
  const seqRef = useRef(0);

  const saveProgress = useCallback((currentStep, currentSubStep, stepData) => {
    const seq = ++seqRef.current;

    const body = {
      current_step: currentStep,
      current_sub_step: currentSubStep || "",
      step_data: stepData || {},
    };

    api("/setup/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});

    return seq;
  }, []);

  return { saveProgress };
}
