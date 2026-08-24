import { cn } from "@/lib/utils";
import React from "react";

/**
 * @param {{ label?: string, heading?: string, disableAnimation?: boolean, className?: string, testId?: string }} _
 */
function LoadingFast({
  label = "Loading...",
  heading = "Warming up",
  disableAnimation = false,
  className = "",
  testId = "loading-fast",
}) {
  return (
    <div
      className={cn("fixed inset-0 z-50 flex flex-col items-center justify-center bg-primary text-secondary transition-colors duration-200", className)}
      data-slot="loading-fast"
      aria-live="polite"
      aria-busy="true"
      data-testid={testId}
    >
      <div className="w-full max-w-xs px-6 sm:max-w-sm">
        {/* Typography & Branding — kept animation-free on purpose: this is the
            first-paint splash, and an opacity:0 entrance delays FCP by the full
            fade duration while making the "loading" state invisible. */}
        <div className="mb-10 text-center">
          <div className="mb-3 text-[0.65rem] font-sans font-semibold uppercase tracking-[0.3em] text-secondary">
            LibreServ
          </div>
          <h1 className="mb-2 text-3xl font-mono font-normal tracking-tight text-secondary sm:text-4xl">
            {heading}
          </h1>
          <p className="font-sans text-sm text-secondary">{label}</p>
        </div>

        {/* Material Design 3 Linear Progress Indicator */}
        <div
          className="relative h-1 w-full overflow-hidden rounded-full bg-secondary/10"
          role="progressbar"
          aria-label="Loading progress"
          aria-valuenow={50}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {/* Primary Bar */}
          <div
            className={cn("absolute bottom-0 top-0 h-full bg-accent origin-left", !disableAnimation ? "animate-md-bar-1" : "opacity-50")}
          ></div>
          {/* Secondary Bar */}
          <div
            className={cn("absolute bottom-0 top-0 h-full bg-accent origin-left", !disableAnimation ? "animate-md-bar-2" : "opacity-50")}
          ></div>
        </div>
      </div>
    </div>
  );
}

export default React.memo(LoadingFast);
