import { useState } from "react";
import PropTypes from "prop-types";
import { Sparkles, Shield, Check } from "lucide-react";
import Card from "../cards/Card.jsx";
import Button from "../ui/Button.jsx";

const PLANS = [
  {
    id: "free",
    name: "Free",
    price: "$0/mo",
    credit: "$0",
    features: ["Ask the AI assistant questions", "View your server status"],
    unavailable: ["No credit for AI actions", "No automatic problem fixing"],
    icon: null,
  },
  {
    id: "basic",
    name: "Basic Support",
    price: "$15/mo",
    credit: "$10 credit",
    features: [
      "$10 monthly credit for AI actions",
      "AI can inspect, diagnose, and restart apps",
      "Automatic problem fixing for crashed apps",
      "Safety reviewer checks every action",
    ],
    unavailable: [],
    icon: Shield,
  },
  {
    id: "premium",
    name: "Premium Support",
    price: "$25/mo",
    credit: "$20 credit",
    features: [
      "$20 monthly credit for AI actions",
      "Everything in Basic, plus:",
      "Automatic problem fixing enabled by default",
      "Option to escalate to human support",
    ],
    unavailable: [],
    icon: Sparkles,
  },
];

/**
 * @param {{ currentPlanId?: any, onSelect: any, onSkip?: any }} _
 */
export default function PlanPicker({ currentPlanId, onSelect, onSkip }) {
  const [selected, setSelected] = useState(currentPlanId || "free");

  function handleSelect() {
    onSelect?.(selected);
  }

  return (
    <Card noHeightAnim noPopIn className="max-w-2xl mx-auto">
      <div className="px-6 py-5 space-y-5">
        <div>
          <h2 className="text-lg font-mono text-primary">Choose Your Support Plan</h2>
          <p className="text-sm text-primary/60 mt-1">
            Your AI assistant uses credits for each action it takes. Pick a plan that fits how much help you need. You can change this anytime in Settings.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {PLANS.map((plan) => {
            const isSelected = selected === plan.id;
            const Icon = plan.icon;
            return (
              <button
                key={plan.id}
                type="button"
                onClick={() => setSelected(plan.id)}
                className={`text-left rounded-large-element p-4 border-2 transition-colors cursor-pointer ${
                  isSelected
                    ? "border-accent bg-accent/5"
                    : "border-primary/5 bg-primary/2 hover:border-primary/10"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  {Icon && <Icon size={16} className="text-accent" />}
                  <span className="font-mono text-primary text-sm">{plan.name}</span>
                </div>
                <p className="text-lg font-mono text-primary mb-3">{plan.price}</p>
                <p className="text-xs text-accent mb-2">{plan.credit} per month</p>
                <ul className="space-y-1">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-primary/70">
                      <Check size={10} className="text-success shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                  {plan.unavailable.map((f, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-primary/30">
                      <span className="shrink-0 mt-0.5 w-2.5 h-px bg-primary/20" />
                      {f}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-primary/10">
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-primary/40 hover:text-primary/60"
          >
            Skip for now
          </button>
          <Button variant="primary" size="md" onClick={handleSelect}>
            {selected === "free" ? "Continue with Free" : `Choose ${PLANS.find((p) => p.id === selected)?.name}`}
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
};
