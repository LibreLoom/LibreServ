import React from "react";

export default React.memo(function LoadingFast({
  label = "Loading...",
  heading = "Warming up",
  disableAnimation = false,
  className = "",
  testId = "loading-fast",
}) {
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-primary text-secondary transition-colors duration-200 ${className}`}
      aria-live="polite"
      aria-busy="true"
      data-testid={testId}
    >
      <div className="w-full max-w-xs px-6 sm:max-w-sm">
        {/* Typography & Branding */}
        <div
          className={`mb-10 text-center ${!disableAnimation ? "animate-fade-in-up" : ""}`}
        >
          <div className="mb-3 text-[0.65rem] font-sans font-semibold uppercase tracking-[0.3em] text-accent opacity-90">
            LibreServ
          </div>
          <h1 className="mb-2 text-3xl font-mono font-normal tracking-tight text-secondary sm:text-4xl">
            {heading}
          </h1>
          <p className="font-sans text-sm text-accent">{label}</p>
        </div>

        {/* Material Design 3 Linear Progress Indicator */}
        <div
          className="relative h-1 w-full overflow-hidden rounded-full bg-secondary/10"
          role="progressbar"
          aria-label="Loading progress"
          aria-valuenow="50"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          {/* Primary Bar */}
          <div
            className={`absolute bottom-0 top-0 h-full bg-accent origin-left ${!disableAnimation ? "animate-mdi-bar-1" : "opacity-50"}`}
          ></div>
          {/* Secondary Bar */}
          <div
            className={`absolute bottom-0 top-0 h-full bg-accent origin-left ${!disableAnimation ? "animate-mdi-bar-2" : "opacity-50"}`}
          ></div>
        </div>
      </div>
    </div>
  );
});
