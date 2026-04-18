import { memo, useMemo } from "react";
import { Check } from "lucide-react";
import PropTypes from "prop-types";

function WizardStepper({ currentStep, hasSubdomainStep }) {
  const steps = useMemo(() => {
    const baseSteps = [
      { id: 1, label: "Overview" },
      { id: 2, label: "Configure" },
    ];

    if (hasSubdomainStep) {
      baseSteps.push({ id: 3, label: "Network" });
    }

    const progressId = hasSubdomainStep ? 4 : 3;
    const completeId = hasSubdomainStep ? 5 : 4;

    baseSteps.push(
      { id: progressId, label: "Installing" },
      { id: completeId, label: "Complete" }
    );

    return baseSteps;
  }, [hasSubdomainStep]);

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
                        ? "bg-secondary text-primary"
                        : isActive
                          ? "bg-secondary text-primary ring-2 ring-secondary ring-offset-2 ring-offset-primary"
                          : "bg-secondary/50 text-secondary/50 border-2 border-secondary/30"
                    }
                  `}
                  aria-current={isActive ? "step" : undefined}
                >
                  {isComplete ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    index + 1
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
                    ${step.id < currentStep ? "bg-secondary" : "bg-secondary/30"}
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
}

WizardStepper.propTypes = {
  currentStep: PropTypes.number.isRequired,
  hasSubdomainStep: PropTypes.bool,
};

WizardStepper.defaultProps = {
  hasSubdomainStep: false,
};

export default memo(WizardStepper);
