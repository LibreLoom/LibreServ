import PropTypes from "prop-types";
import { Check } from "lucide-react";
import { SMTP_PRESETS } from "../smtp-wiz-constants";

export default function SmtpConnectedStep({ preset, host, from }) {
  const presetData = SMTP_PRESETS[preset] || SMTP_PRESETS.custom;
  const providerLabel = presetData.label;

  const rows = [
    { label: "Provider", value: providerLabel },
    { label: "Server", value: host },
    { label: "From", value: from },
  ];

  return (
    <div className="flex flex-col items-center text-center py-4">
      <div className="w-14 h-14 rounded-full bg-success/12 border border-success/20 flex items-center justify-center mb-6">
        <Check className="w-6 h-6 text-success" strokeWidth={2} />
      </div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        SMTP connected!
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        Your email is set up and ready to send.
      </p>
      <div className="w-full text-left space-y-0 mb-6">
        {rows.map(({ label, value }) => (
          <div
            key={label}
            className="flex items-center justify-between py-2.5 border-b border-primary/10 last:border-0"
          >
            <span className="text-xs text-primary/35 font-mono uppercase tracking-wider">
              {label}
            </span>
            <span className="text-sm text-primary/80 font-mono truncate ml-4">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

SmtpConnectedStep.propTypes = {
  preset: PropTypes.string.isRequired,
  host:   PropTypes.string.isRequired,
  from:   PropTypes.string.isRequired,
};
