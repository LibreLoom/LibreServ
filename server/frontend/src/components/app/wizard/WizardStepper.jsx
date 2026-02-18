import { memo } from "react";
import { Check } from "lucide-react";

const steps = [
  { id: 1, label: "Overview" },
  { id: 2, label: "Configure" },
  { id: 3, label: "Installing" },
  { id: 4, label: "Complete" },
];

export default memo(function WizardStepper({ currentStep }) {
  return (
    <nav aria-label="Installation progress" className="w-full">
      <ol className="flex items-center justify-center gap-2 sm:gap-4">
        {steps.map((step, index) => {
          const isActive = step.id === currentStep;
          const isComplete = step.id < currentStep;
          const isLast = index === steps.length - 1;

          return (
            <li key={step.id} className="flex items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`
                    flex h-8 w-8 items-center justify-center rounded-full font-mono text-sm
                    motion-safe:transition-all
                    ${
                      isComplete
                        ? "bg-accent text-primary"
                        : isActive
                          ? "bg-accent text-primary ring-2 ring-accent ring-offset-2 ring-offset-primary"
                          : "bg-secondary/50 text-secondary/50 border-2 border-secondary/30"
                    }
                  `}
                  aria-current={isActive ? "step" : undefined}
                >
                  {isComplete ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    step.id
                  )}
                </div>
                <span
                  className={`
                    hidden sm:block font-mono text-sm
                    ${isActive ? "text-secondary" : "text-secondary/50"}
                  `}
                >
                  {step.label}
                </span>
              </div>

              {!isLast && (
                <div
                  className={`
                    mx-2 sm:mx-4 h-0.5 w-4 sm:w-8
                    ${step.id < currentStep ? "bg-accent" : "bg-secondary/30"}
                  `}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
});
