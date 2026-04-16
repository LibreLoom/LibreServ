import PropTypes from "prop-types";
import { Globe, ShoppingCart } from "lucide-react";

const OPTIONS = [
  {
    id: "buy",
    label: "I need to buy one",
    desc: "We\u2019ll help you find a registrar",
    Icon: ShoppingCart,
    primary: true,
  },
  {
    id: "has",
    label: "Yes, I have a domain",
    desc: "Connect a domain you already own",
    Icon: Globe,
    primary: false,
  },
];

export default function HasDomainStep({ onNext, onBuy }) {
  return (
    <div className="flex flex-col items-center text-center py-4">
      <div className="mb-8">
        <ShoppingCart size={48} className="text-primary/30 mx-auto mb-4" />
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
          Do you have a domain?
        </h2>
        <p className="text-primary/50 text-sm leading-relaxed max-w-sm mx-auto">
          A domain gives your apps a memorable address and a secure connection. You can add one later too.
        </p>
      </div>
      <div className="w-full space-y-2.5">
        {OPTIONS.map(({ id, label, desc, Icon, primary }) => (
          <button
            key={id}
            type="button"
            onClick={id === "has" ? onNext : onBuy}
            className={`w-full flex items-center gap-4 p-4 rounded-large-element border motion-safe:transition-all motion-safe:duration-200 ${
              primary
                ? "border-primary/15 bg-primary/5 hover:bg-primary/10 hover:border-primary/25 text-primary"
                : "border-primary/10 bg-primary/[0.03] hover:bg-primary/8 hover:border-primary/20 text-primary"
            }`}
          >
            <div className="flex-shrink-0 w-9 h-9 rounded-full bg-primary/8 flex items-center justify-center">
              <Icon size={18} className="text-primary/50" />
            </div>
            <div className="flex-1 text-left">
              <div className="font-mono text-sm">{label}</div>
              <div className="text-xs text-primary/35 mt-0.5">{desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

HasDomainStep.propTypes = {
  onNext: PropTypes.func.isRequired,
  onBuy: PropTypes.func.isRequired,
};
