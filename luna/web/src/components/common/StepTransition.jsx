import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * StepTransition — slides between steps of a multi-step flow.
 *
 * Pass the current step id and the ordered list of all step ids. When `step`
 * advances through the order, the content slides in from the right; going
 * back slides in from the left. Content is re-keyed by step, so each step
 * mounts fresh with its entrance animation (and local DOM state resets).
 *
 * Usage:
 *   <StepTransition step={current} order={["form", "mfa"]}>
 *     {contentForCurrentStep}
 *   </StepTransition>
 */
export default function StepTransition({ step, order, children, className = "" }) {
  const [prevStep, setPrevStep] = useState(step);
  const [direction, setDirection] = useState(0); // 1 = forward, -1 = back, 0 = first render

  // Render-phase state adjustment (React docs pattern): when `step` changes,
  // compute the slide direction before the new step is committed.
  if (prevStep !== step) {
    const prevIndex = order.indexOf(prevStep);
    const nextIndex = order.indexOf(step);
    setDirection(nextIndex > prevIndex ? 1 : -1);
    setPrevStep(step);
  }

  const slideClass =
    direction > 0
      ? "animate-in slide-in-from-right-4 duration-300"
      : direction < 0
        ? "animate-in slide-in-from-left-4 duration-300"
        : "";

  return (
    <div key={step} className={cn(slideClass, className)}>
      {children}
    </div>
  );
}