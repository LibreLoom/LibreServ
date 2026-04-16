import PropTypes from "prop-types";
import { Lock } from "lucide-react";
import {
  CloudflareIcon,
  PorkbunIcon,
  SpaceshipIcon,
} from "../icons";

const REGISTRARS = [
  {
    id: "cloudflare_reg",
    label: "Cloudflare Registrar",
    desc: "Recommended \u2014 great price, works perfectly with Cloudflare",
    Icon: CloudflareIcon,
    ready: true,
    recommended: true,
  },
  {
    id: "porkbun",
    label: "Porkbun",
    desc: "Coming soon",
    Icon: PorkbunIcon,
    ready: false,
    recommended: false,
  },
  {
    id: "spaceship",
    label: "Spaceship",
    desc: "Coming soon",
    Icon: SpaceshipIcon,
    ready: false,
    recommended: false,
  },
];

export default function RegistrarPickStep({ selected, onSelect }) {
  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Where to buy a domain
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        For use with LibreServ, we recommend buying a domain from one of the registrars listed below.
      </p>
      <div className="space-y-2">
        {REGISTRARS.map(({ id, label, desc, Icon, ready, recommended }) => (
          <button
            key={id}
            type="button"
            onClick={() => ready && onSelect(id)}
            disabled={!ready}
            className={`w-full flex items-center gap-4 p-4 rounded-large-element border motion-safe:transition-all motion-safe:duration-200 ${
              selected === id
                ? "border-accent bg-accent/10"
                : ready
                ? "border-primary/15 bg-primary/5 hover:bg-primary/10 hover:border-primary/25 cursor-pointer"
                : "border-primary/10 bg-primary/5 opacity-40 cursor-not-allowed"
            }`}
          >
            <div className={`flex-shrink-0 ${ready ? "" : "opacity-50"}`}>
              <Icon size={22} />
            </div>
            <div className="flex-1 text-left">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-primary">{label}</span>
                {recommended && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-accent/15 text-accent">
                    Recommended
                  </span>
                )}
              </div>
              <div className="text-xs text-primary/40">{desc}</div>
            </div>
            {!ready && <Lock size={14} className="text-primary/25 flex-shrink-0" />}
          </button>
        ))}
      </div>
    </div>
  );
}

RegistrarPickStep.propTypes = {
  selected: PropTypes.string,
  onSelect: PropTypes.func.isRequired,
};
