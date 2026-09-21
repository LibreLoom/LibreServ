import { memo, useMemo } from "react";
import { Check } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import { ICON_SIZE } from "@/lib/ui-tokens";

function WizardStepper({ currentStep, hasSubdomainStep }) {
  const steps = useMemo(() => {
    const baseSteps = [
      { id: 1, label: "Overview" },
      { id: 2, label: "Configure" },
    ];

    if (hasSubdomainStep) {
      baseSteps.push({ id: 3, label: "Network" });
    } else {
      baseSteps.push({ id: 3, label: "Domain Required" });
    }

    baseSteps.push(
      { id: 4, label: "Installing" },
      { id: 5, label: "Complete" }
    );

    return baseSteps;
  }, [hasSubdomainStep]);

  return (
    <nav aria-label="Installation progress" className="w-full" data-slot="wizard-stepper">
      <ol className="flex items-center justify-center gap-2 sm:gap-4">
        {steps.map((step, index) => {
          const isActive = step.id === currentStep;
          const isComplete = step.id < currentStep;
          const isLast = index === steps.length - 1;

          return (
            <li key={step.id} className="flex items-center">
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full font-mono text-sm motion-safe:transition-all duration-300 ease-in-out",
                    isComplete && "bg-secondary text-primary scale-100",
                    !isComplete && isActive && "bg-secondary text-primary scale-110",
                    !isComplete && !isActive && "bg-secondary/50 text-accent border-2 border-secondary/30 scale-100"
                  )}
                  aria-current={isActive ? "step" : undefined}
                  style={{
                    transitionDelay: isActive ? '100ms' : '0ms'
                  }}
                >
                  {isComplete ? (
                    <Check 
                      size={ICON_SIZE.md} 
                      aria-hidden="true"
                      className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-0 motion-safe:duration-200"
                    />
                  ) : (
                    <span className={cn(
                      "motion-safe:transition-transform motion-safe:duration-200",
                      isActive && "scale-110"
                    )}>
                      {index + 1}
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    "hidden sm:block font-mono text-sm motion-safe:transition-all motion-safe:duration-300 ease-in-out",
                    isActive 
                      ? "text-secondary opacity-100 translate-x-0" 
                      : "text-accent opacity-70"
                  )}
                  style={{
                    transitionDelay: isActive ? '150ms' : '0ms'
                  }}
                >
                  {step.label}
                </span>
              </div>

              {!isLast && (
                <div
                  className={cn(
                    "mx-4 sm:mx-6 h-0.5 w-4 sm:w-8 motion-safe:transition-all motion-safe:duration-500 ease-in-out",
                    step.id < currentStep ? "bg-secondary" : "bg-secondary/30"
                  )}
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
