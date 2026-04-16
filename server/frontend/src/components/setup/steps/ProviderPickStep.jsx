import PropTypes from "prop-types";
import { Lock } from "lucide-react";
import { CloudflareIcon, PorkbunIcon, SpaceshipIcon } from "../icons";

const REGISTRARS = [
  { id: "cloudflare", label: "Cloudflare", desc: "Manages your domain\u2019s address book", Icon: CloudflareIcon, ready: true },
  { id: "porkbun",   label: "Porkbun",   desc: "Coming soon",                         Icon: PorkbunIcon,   ready: false },
  { id: "spaceship",  label: "Spaceship",  desc: "Coming soon",                         Icon: SpaceshipIcon, ready: false },
];

const ELSEWHERE = {
  id:    "cf_ns",
  label: "Use Cloudflare Nameservers",
  desc:  "Your domain stays at your current registrar, but Cloudflare handles the address book.",
  Icon:  CloudflareIcon,
  ready: true,
};

function ProviderCard({ id, label, desc, Icon, ready, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={() => ready && onClick(id)}
      disabled={!ready}
      className={`w-full flex items-center gap-4 p-4 rounded-large-element border motion-safe:transition-all motion-safe:duration-200 ${
        selected === id
          ? "border-accent bg-accent/10"
          : ready
          ? "border-primary/15 bg-primary/5 hover:bg-primary/10 hover:border-primary/25"
          : "border-primary/10 bg-primary/5 opacity-40 cursor-not-allowed"
      }`}
    >
      <div className={`flex-shrink-0 ${ready ? "" : "opacity-50"}`}>
        <Icon size={22} />
      </div>
      <div className="flex-1 text-left">
        <div className="font-mono text-sm text-primary">{label}</div>
        <div className="text-xs text-primary/40">{desc}</div>
      </div>
      {!ready && <Lock size={14} className="text-primary/25 flex-shrink-0" />}
    </button>
  );
}

ProviderCard.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  desc: PropTypes.string.isRequired,
  Icon: PropTypes.elementType.isRequired,
  ready: PropTypes.bool,
  selected: PropTypes.string,
  onClick: PropTypes.func.isRequired,
};

export default function ProviderPickStep({ selected, onSelect }) {
  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Where did you get your domain?
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        Select the registrar (provider) that currently manages your domain.
      </p>
      <div className="space-y-2">
        {REGISTRARS.map((r) => (
          <ProviderCard key={r.id} {...r} selected={selected} onClick={onSelect} />
        ))}
      </div>

      <div className="mt-4 p-3 rounded-card bg-primary/5 border border-primary/10">
        <p className="text-xs text-primary/50 leading-relaxed">
          <span className="text-primary/70 font-medium">Heads up:</span> If your domain is managed by one of the above but you changed the nameservers, you may need to switch them back — unless you use Cloudflare nameservers.
        </p>
      </div>

      <div className="flex items-center gap-3 my-5">
        <div className="flex-1 h-px bg-primary/15" />
        <span className="text-xs text-primary/30 font-mono uppercase tracking-wider">Elsewhere</span>
        <div className="flex-1 h-px bg-primary/15" />
      </div>

      <ProviderCard {...ELSEWHERE} selected={selected} onClick={onSelect} />
    </div>
  );
}

ProviderPickStep.propTypes = {
  selected: PropTypes.string,
  onSelect: PropTypes.func.isRequired,
};
