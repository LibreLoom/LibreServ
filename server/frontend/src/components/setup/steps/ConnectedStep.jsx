import PropTypes from "prop-types";
import { Check, Shield, ShieldOff, Clock } from "lucide-react";

function CertBadge({ status }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 text-success text-xs font-mono">
        <Shield size={12} />
        Active
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center gap-1.5 text-primary/40 text-xs font-mono">
        <ShieldOff size={12} />
        Not configured
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-warning text-xs font-mono">
      <Clock size={12} />
      Pending
    </span>
  );
}

CertBadge.propTypes = { status: PropTypes.string };

export default function ConnectedStep({ domain, provider, connectStatus, publicIP }) {
  const certStatus = connectStatus?.certificate;
  const ip = connectStatus?.public_ip ?? publicIP ?? "\u2014";
  const providerLabel = provider === "cf_ns" ? "Cloudflare (via nameservers)" : "Cloudflare";

  const rows = [
    { label: "Domain", value: domain },
    { label: "Provider", value: providerLabel },
    { label: "Server", value: ip },
  ];

  return (
    <div className="flex flex-col items-center text-center py-4">
      <div className="w-14 h-14 rounded-full bg-success/12 border border-success/20 flex items-center justify-center mb-6">
        <Check className="w-6 h-6 text-success" strokeWidth={2} />
      </div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        You&rsquo;re connected!
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        Your domain is set up and ready to go.
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
            <span className="text-sm text-primary/80 font-mono">{value}</span>
          </div>
        ))}
        <div className="flex items-center justify-between py-2.5">
          <span className="text-xs text-primary/35 font-mono uppercase tracking-wider">
            HTTPS
          </span>
          <CertBadge status={certStatus} />
        </div>
      </div>
    </div>
  );
}

ConnectedStep.propTypes = {
  domain:        PropTypes.string.isRequired,
  provider:      PropTypes.string.isRequired,
  connectStatus: PropTypes.object,
  publicIP:      PropTypes.string,
};
