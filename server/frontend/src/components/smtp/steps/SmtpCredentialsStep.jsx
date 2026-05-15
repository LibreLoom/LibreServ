import { useState } from "react";
import PropTypes from "prop-types";
import { Eye, EyeOff, ExternalLink, AlertCircle } from "lucide-react";
import CollapsibleSection from "../../common/CollapsibleSection";
import { SMTP_PRESETS } from "../smtp-wiz-constants";

const inputClass = "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/50 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

export default function SmtpCredentialsStep({ preset, config, onConfigChange, error, onEnter }) {
  const [showPassword, setShowPassword] = useState(false);
  const presetData = SMTP_PRESETS[preset] || SMTP_PRESETS.custom;

  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        {presetData.label} credentials
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        Enter the connection details for your {presetData.label} SMTP server.
      </p>

      <div className="space-y-4 mb-5">
        {preset === "custom" && (
          <div>
            <label htmlFor="smtp-host" className="block text-sm text-primary/60 translate-x-5 mb-1">
              SMTP Host <span className="text-error" aria-hidden="true">*</span>
            </label>
            <input
              id="smtp-host"
              type="text"
              value={config.host}
              onChange={(e) => onConfigChange({ ...config, host: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
              placeholder="smtp.example.com"
              className={inputClass}
              autoComplete="off"
            />
          </div>
        )}

        {preset === "custom" && (
          <div>
            <label htmlFor="smtp-port" className="block text-sm text-primary/60 translate-x-5 mb-1">
              Port
            </label>
            <input
              id="smtp-port"
              type="number"
              value={config.port}
              onChange={(e) => onConfigChange({ ...config, port: parseInt(e.target.value) || 587 })}
              onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
              placeholder="587"
              className={inputClass}
            />
          </div>
        )}

        <div>
          <label htmlFor="smtp-username" className="block text-sm text-primary/60 translate-x-5 mb-1">
            {presetData.username_label} <span className="text-error" aria-hidden="true">*</span>
          </label>
          <input
            id="smtp-username"
            type="text"
            value={config.username}
            onChange={(e) => onConfigChange({ ...config, username: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
            placeholder={preset === "proton" ? "you@yourdomain.com" : preset === "resend" ? "resend" : ""}
            className={inputClass}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div>
          <label htmlFor="smtp-password" className="block text-sm text-primary/60 translate-x-5 mb-1">
            {presetData.password_label} <span className="text-error" aria-hidden="true">*</span>
          </label>
          <div className="relative">
            <input
              id="smtp-password"
              type={showPassword ? "text" : "password"}
              value={config.password}
              onChange={(e) => onConfigChange({ ...config, password: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
              placeholder={preset === "resend" ? "re_xxxxxxxxx" : "••••••••"}
              className={`${inputClass} pr-12`}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-primary/30 hover:text-primary/60 motion-safe:transition-colors motion-safe:duration-150"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="smtp-from" className="block text-sm text-primary/60 translate-x-5 mb-1">
            From email <span className="text-error" aria-hidden="true">*</span>
          </label>
          <input
            id="smtp-from"
            type="email"
            value={config.from}
            onChange={(e) => onConfigChange({ ...config, from: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
            placeholder={preset === "proton" ? "you@yourdomain.com" : "noreply@yourdomain.com"}
            className={inputClass}
            autoComplete="email"
          />
          {preset === "proton" && (
            <p className="text-xs text-amber-500/80 mt-1.5 translate-x-5 flex items-start gap-1.5">
              <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
              Must be a custom domain email already configured in Proton Mail Settings → Domain.
            </p>
          )}
          {preset !== "proton" && (
            <p className="text-xs text-primary/35 mt-1.5 translate-x-5">
              The address your emails will be sent from.
            </p>
          )}
        </div>
      </div>

      {presetData.help && (
        <CollapsibleSection title={`${presetData.label} setup help`} size="xs" pill>
          <div className="space-y-3">
            <p className="text-xs text-primary/60 leading-relaxed">
              {presetData.help}
            </p>
            {presetData.docs_url && (
              <div className="flex items-center gap-2 pt-2">
                <a
                  href={presetData.docs_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-pill border border-primary/15 bg-primary/5 text-primary px-3.5 py-2 font-mono text-xs motion-safe:transition-all motion-safe:duration-200 hover:bg-primary/10 hover:border-primary/25"
                >
                  <ExternalLink size={12} />
                  Open Documentation
                </a>
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {error && (
        <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 mt-4 animate-in fade-in slide-in-from-bottom-1 duration-200">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
          <p className="text-sm text-primary/80">{error}</p>
        </div>
      )}
    </div>
  );
}

SmtpCredentialsStep.propTypes = {
  preset:          PropTypes.string.isRequired,
  config:          PropTypes.shape({
    host:     PropTypes.string,
    port:     PropTypes.number,
    username: PropTypes.string,
    password: PropTypes.string,
    from:     PropTypes.string,
  }).isRequired,
  onConfigChange:  PropTypes.func.isRequired,
  error:           PropTypes.string,
  onEnter:         PropTypes.func,
};
