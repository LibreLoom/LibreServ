import PropTypes from "prop-types";
import { SMTP_PRESETS } from "../smtp-wiz-constants";
import { ProtonIcon, ResendIcon, PostmarkIcon, CustomSmtpIcon } from "../icons";

const PRESET_LIST = [
  { ...SMTP_PRESETS.proton,   Icon: ProtonIcon,    desc: "Privacy-first email with token-based SMTP" },
  { ...SMTP_PRESETS.resend,   Icon: ResendIcon,    desc: "Developer-focused, simple API key auth" },
  { ...SMTP_PRESETS.postmark, Icon: PostmarkIcon,  desc: "Transactional-only, rock-solid delivery" },
  { ...SMTP_PRESETS.custom,   Icon: CustomSmtpIcon, desc: "Enter your own server details" },
];

function ProviderCard({ id, label, desc, Icon, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`w-full flex items-center gap-4 p-4 rounded-large-element border motion-safe:transition-all motion-safe:duration-200 ${
        selected === id
          ? "border-accent bg-accent/10"
          : "border-primary/15 bg-primary/5 hover:bg-primary/10 hover:border-primary/25"
      }`}
    >
      <div className="flex-shrink-0">
        <Icon size={22} />
      </div>
      <div className="flex-1 text-left">
        <div className="font-mono text-sm text-primary">{label}</div>
        <div className="text-xs text-primary/40">{desc}</div>
      </div>
    </button>
  );
}

ProviderCard.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  desc: PropTypes.string.isRequired,
  Icon: PropTypes.elementType.isRequired,
  selected: PropTypes.string,
  onClick: PropTypes.func.isRequired,
};

export default function SmtpProviderPickStep({ selected, onSelect }) {
  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Choose your email provider
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        Pick the service that will deliver your emails. We&apos;ll fill in the server details for you.
      </p>
      <div className="space-y-2">
        {PRESET_LIST.map((p) => (
          <ProviderCard key={p.id} {...p} selected={selected} onClick={onSelect} />
        ))}
      </div>
    </div>
  );
}

SmtpProviderPickStep.propTypes = {
  selected: PropTypes.string,
  onSelect: PropTypes.func.isRequired,
};
