import { useState } from "react";
import PropTypes from "prop-types";
import { Check, X } from "lucide-react";
import Card from "../cards/Card.jsx";
import Button from "../ui/Button.jsx";

function PlanPicker({ currentPlanId, onSelect, onSkip, plans }) {
  const [selected, setSelected] = useState(currentPlanId || plans[0]?.id || "");

  function handleSelect() {
    onSelect?.(selected);
  }

  return (
    <Card className="max-w-2xl mx-auto">
      <div className="px-4 space-y-3">
        <div>
          <h2 className="text-lg font-mono text-primary">Choose Your Support Plan</h2>
          <p className="text-sm text-primary/60 mt-1">
            Your AI assistant uses credits for each action it takes. Pick a plan that fits how much help you need. You can change this anytime in Settings.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {plans.map((plan) => {
            const isSelected = selected === plan.id;
            const Icon = plan.icon;
            return (
              <button
                key={plan.id}
                type="button"
                onClick={() => setSelected(plan.id)}
                className={`text-left rounded-large-element p-4 border-2 motion-safe:transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent flex flex-col ${
                  isSelected
                    ? "border-accent bg-accent/5"
                    : "border-primary/5 bg-primary/2 hover:border-primary/10"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  {Icon && <Icon size={16} className="text-accent" />}
                  <span className="font-mono text-primary text-sm">{plan.name}</span>
                </div>
                <p className="text-lg font-mono text-primary mb-2">{plan.price}</p>
                <p className="text-xs text-accent mb-1">{plan.credit} per month</p>
                <ul className="space-y-1">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-primary/70">
                      <Check size={10} className="text-success shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                  {plan.unavailable.map((f, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-primary/30">
                      <X size={10} className="shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-primary/10">
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="text-xs text-primary/40 hover:text-primary/60 motion-safe:transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent rounded-pill px-1"
            >
              Skip for now
            </button>
          )}
          <div className="flex-1" />
          <Button variant="primary" size="md" onClick={handleSelect} smoothResize>
            Choose {plans.find((p) => p.id === selected)?.name}
          </Button>
        </div>
      </div>
    </Card>
  );
}

PlanPicker.propTypes = {
  currentPlanId: PropTypes.string,
  onSelect: PropTypes.func.isRequired,
  onSkip: PropTypes.func,
  plans: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      price: PropTypes.string.isRequired,
      credit: PropTypes.string,
      features: PropTypes.arrayOf(PropTypes.string),
      unavailable: PropTypes.arrayOf(PropTypes.string),
      icon: PropTypes.elementType,
    })
  ).isRequired,
};

export default PlanPicker;
