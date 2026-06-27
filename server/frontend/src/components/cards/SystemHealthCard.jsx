import { memo } from "react";
import PropTypes from "prop-types";
import { CheckCircle, XCircle, HelpCircle, HeartPulse } from "lucide-react";
import Card from "./Card";

// Plain-language labels for technical health-check names (AGENTS.md
// plain-language rule: a non-technical user should not see "caddy_certs_writable").
const CHECK_LABELS = {
  disk_space: "Storage space",
  smtp: "Email delivery",
  caddy_certs_writable: "HTTPS certificate folder",
  caddy_admin_writable: "Web server config folder",
  caddy_config_writable: "Web server config file",
  acme_data_writable: "HTTPS certificate data",
  acme_certs_writable: "HTTPS certificate storage",
  database: "Database",
};

function prettifyName(name) {
  return String(name)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function labelFor(name) {
  return CHECK_LABELS[name] || prettifyName(name);
}

function statusMeta(status) {
  switch (status) {
    case "passed":
      return { Icon: CheckCircle, className: "text-success" };
    case "failed":
    case "error":
      return { Icon: XCircle, className: "text-error" };
    default:
      return { Icon: HelpCircle, className: "text-accent" };
  }
}

function SystemHealthCard({ checks = {}, overallPass, loading, error }) {
  const entries = Object.entries(checks);
  const overallLabel = overallPass ? "Healthy" : "Needs attention";
  const overallClass = overallPass ? "text-success" : "text-error";

  return (
    <Card icon={HeartPulse} title="System Health" padding={false}>
      <div className="px-5 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-primary/70">Overall</span>
          <span className={`text-sm font-mono font-medium ${overallClass}`}>
            {overallLabel}
          </span>
        </div>
        {loading ? (
          <p className="text-sm text-accent">Checking…</p>
        ) : error ? (
          <p className="text-sm text-accent">
            We couldn’t check system health right now.
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-accent">No checks available.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map(([name, result]) => {
              const { Icon, className } = statusMeta(result?.status);
              return (
                <li key={name} className="flex items-start gap-2">
                  <Icon
                    size={16}
                    className={`${className} mt-0.5 shrink-0`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="text-sm text-primary">{labelFor(name)}</div>
                    {result?.message && (
                      <div className="text-xs text-accent truncate">
                        {result.message}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

SystemHealthCard.propTypes = {
  checks: PropTypes.object,
  overallPass: PropTypes.bool,
  loading: PropTypes.bool,
  error: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
};

export default memo(SystemHealthCard);